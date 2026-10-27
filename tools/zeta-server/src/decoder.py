"""Greedy MLX decoding with exact causal verification of prompt lookup drafts.

The draft is only a proposal. Every emitted token is the target model's argmax.
No model weights or installed runtime are modified.
"""
from __future__ import annotations

from collections import defaultdict
from contextlib import contextmanager
import hashlib
import json
import logging
import os
import platform
import sys
import threading
import traceback
from collections.abc import Sequence
from typing import TYPE_CHECKING, Callable, Literal, cast

import mlx.core as mx

from observability import span_scope
from opentelemetry import trace
from mlx_lm import load
from mlx_lm.models.cache import make_prompt_cache, trim_prompt_cache
from typing_contracts import (
    CancellationCheck, GenerationResult, MemorySnapshot, TokenCallback, TokenSequence,
)

if TYPE_CHECKING:
    from mlx_lm import LanguageModel, PromptCache, Tokenizer


PREFILL_STEP_SIZE = 512
ZETA_EOS_MARKER = '<[end▁of▁sentence]>'


def _eval_array(value: mx.array) -> None:
    # MLX's eval stub has an untyped variadic signature; keep the narrow wrapper typed.
    evaluate = cast(Callable[[mx.array], None], getattr(mx, 'eval'))
    evaluate(value)


def is_no_edit_prefix(text: str) -> bool:
    """Conservatively recognize prefixes of two identical marker boundaries."""
    # Incremental decoding can replace an unfinished Unicode tail. Only use
    # ASCII structure (plus the known EOS spelling) to prove impossibility.
    for index, char in enumerate(text):
        if not char.isascii() and not char.isspace() and char != '▁':
            text = text[:index]
            break
    text = text.lstrip()
    opening = '<|marker_'
    if len(text) < len(opening):
        return opening.startswith(text)
    if not text.startswith(opening):
        return False
    text = text[len(opening):]
    digit_count = 0
    while digit_count < len(text) and '0' <= text[digit_count] <= '9':
        digit_count += 1
    if not text:
        return True
    if digit_count == 0:
        return False
    digits, text = text[:digit_count], text[digit_count:]
    for literal in ('|>', f'<|marker_{digits}|>', ZETA_EOS_MARKER):
        if len(text) < len(literal):
            return literal.startswith(text)
        if not text.startswith(literal):
            return False
        text = text[len(literal):].lstrip()
    return not text


def nonnegative_int(value: str) -> int:
    parsed_value = int(value)
    if parsed_value < 0:
        raise ValueError('must be a nonnegative integer')
    return parsed_value


def clear_exception_frames(error: BaseException) -> None:
    pending: list[BaseException] = [error]
    seen: set[int] = set()
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        traceback.clear_frames(current.__traceback__)
        # Both chains can retain frames, including a suppressed context, and
        # user-raised exceptions can link them into cycles.
        if current.__cause__ is not None:
            pending.append(current.__cause__)
        if current.__context__ is not None:
            pending.append(current.__context__)


class GenerationCancelled(InterruptedError):
    """A cancellation observed between completed and recorded model calls."""


class PromptLookup:
    def __init__(self, sources: Sequence[Sequence[int]], max_ngram: int = 12) -> None:
        self.sources = sources
        self.max_ngram = max_ngram
        self.index: defaultdict[tuple[int, ...], list[tuple[int, int]]] = defaultdict(list)
        for source_id, source in enumerate(sources):
            for end in range(2, len(source)):
                self.index[tuple(source[end - 2:end])].append((source_id, end))

    def propose(self, history: Sequence[int], count: int) -> TokenSequence:
        if len(history) < 2 or count <= 0:
            return []
        best: TokenSequence = []
        best_match = 1
        for source_id, end in reversed(self.index.get(tuple(history[-2:]), ())):
            source = self.sources[source_id]
            match = 2
            while (match < min(self.max_ngram, len(history), end)
                   and history[-match - 1] == source[end - match - 1]):
                match += 1
            candidate = list(source[end:end + count])
            if match > best_match or (match == best_match and len(candidate) > len(best)):
                best, best_match = candidate, match
        # Short suffixes are common punctuation and make expensive poor drafts.
        return best[:2] if best_match < 4 else best


class MLXAllocator:
    """One process-wide allocator policy shared by the server's model decoders."""

    def __init__(self, cache_limit_mb: int = 256) -> None:
        if type(cache_limit_mb) is not int or cache_limit_mb < 0:
            raise ValueError('cache_limit_mb must be a nonnegative integer')
        self.cache_limit_bytes = cache_limit_mb * 1024 * 1024
        self.lock = threading.RLock()
        self.active = 0
        mx.set_cache_limit(self.cache_limit_bytes)

    def configure_residency(self, refresh_interval_ms: int | str) -> None:
        """Apply one shared, bounded residency budget after both models load."""
        try:
            interval = int(refresh_interval_ms)
            if interval <= 0:
                return
            if (sys.platform != 'darwin'
                    or int(platform.mac_ver()[0].split('.')[0]) < 15
                    or not mx.metal.is_available()):
                raise RuntimeError('residency refresh requires Metal on macOS 15 or later')
            pages = os.sysconf('SC_PHYS_PAGES')
            page_size = os.sysconf('SC_PAGE_SIZE')
            recommended = mx.device_info(mx.gpu)['max_recommended_working_set_size']
            active = mx.get_active_memory()
            if (type(pages) is not int or pages <= 0
                    or type(page_size) is not int or page_size <= 0
                    or type(recommended) is not int or recommended <= 0):
                raise ValueError('memory capacities must be positive integers')
            if type(active) is not int or active < 0:
                raise ValueError('active memory must be a nonnegative integer')
            budget = min(active + self.cache_limit_bytes,
                         pages * page_size // 4, recommended // 2)
            if budget <= 0:
                raise ValueError('no capacity available for the residency budget')
            mx.set_wired_limit(budget)
        except Exception as error:
            logging.getLogger(__name__).warning('MLX residency configuration skipped: %s', error)
            return
        print(json.dumps({'mlx_residency': {'wired_limit_bytes': budget,
                                          'refresh_interval_ms': interval}}), flush=True)

    @contextmanager
    def session(self):
        with self.lock:
            self.active += 1
        pending_error = None
        try:
            yield
        except BaseException as error:
            pending_error = error
            raise
        finally:
            try:
                with self.lock:
                    self.active -= 1
                    # Both finishing requests may have synchronized their own
                    # streams while active was still two. The final departure
                    # must recheck the global cache before admitting new work.
                    if self.active == 0 and mx.get_cache_memory() > self.cache_limit_bytes:
                        mx.clear_cache()
            except Exception as cleanup_error:
                if pending_error is None:
                    raise
                pending_error.add_note(f'Allocator cleanup failed: {cleanup_error}')
            finally:
                del pending_error

    def reclaim(self) -> None:
        # New inference cannot enter while we synchronize/reclaim. When another
        # decoder is active, synchronize only our stream and defer global clear
        # until the final active decoder finishes its own cleanup.
        with self.lock:
            mx.synchronize()
            if self.active <= 1 and mx.get_cache_memory() > self.cache_limit_bytes:
                mx.clear_cache()


class Decoder:
    def __init__(self, model_path: str, context_length: int | None = None,
                 cache_limit_mb: int = 256, allocator: MLXAllocator | None = None) -> None:
        self.allocator = allocator if allocator is not None else MLXAllocator(cache_limit_mb)
        self.cache_limit_bytes = self.allocator.cache_limit_bytes
        self.stream = mx.new_thread_local_stream(mx.gpu)
        self.model: LanguageModel
        self.tokenizer: Tokenizer
        self.model, self.tokenizer = load(model_path)
        model_context = getattr(getattr(self.model, 'args', None),
                                'max_position_embeddings', 32768)
        if type(model_context) is not int or model_context <= 0:
            model_context = 32768
        if context_length is None:
            context_length = model_context
        if type(context_length) is not int or not 0 < context_length <= model_context:
            raise ValueError(f'context_length must be between 1 and {model_context}')
        self.context_length = context_length
        self.cache: PromptCache = make_prompt_cache(self.model)
        if not all(c.is_trimmable() for c in self.cache):
            raise ValueError('Source verification requires trimmable target KV caches')
        self.cached_tokens: TokenSequence = []
        self.lock = threading.Lock()
        self._reclaim_cache()

    def _reclaim_cache(self) -> None:
        self.allocator.reclaim()

    def _release_request_state(self) -> None:
        # Zeta retains its prefix cache; request-only decoders can release theirs.
        pass

    def memory_snapshot(self) -> MemorySnapshot:
        snapshot: MemorySnapshot = {
            'scope': 'process', 'active_bytes': mx.get_active_memory(),
            'cache_bytes': mx.get_cache_memory(), 'peak_bytes': mx.get_peak_memory(),
            'kv_cache_bytes': sum(cache.nbytes for cache in self.cache),
            'cache_limit_bytes': self.cache_limit_bytes,
        }
        return snapshot

    def _prefill(self, chunk: Sequence[int]) -> mx.array:
        # The public wrappers project every position to a large vocabulary.
        # Only the last prompt position is needed; preserve its exact projection.
        if getattr(self.model, 'model_type', None) in ('llama', 'qwen2'):
            hidden = self.model.model(mx.array([chunk]), cache=self.cache)[:, -1:, :]
            if self.model.args.tie_word_embeddings:
                return self.model.model.embed_tokens.as_linear(hidden)
            return self.model.lm_head(hidden)
        return self.model(mx.array([chunk]), cache=self.cache)

    def generate(self, prompt: str, max_tokens: object = 2048,
                 stop: object = None,
                 mode: Literal['source', 'greedy'] = 'source', draft_size: object = 96,
                 cancelled: CancellationCheck | None = None,
                 on_first_token: TokenCallback | None = None,
                 on_no_edit_impossible: TokenCallback | None = None) -> GenerationResult:
        if mode not in ('source', 'greedy'):
            raise ValueError('mode must be source or greedy')
        if not isinstance(max_tokens, int) or not 0 <= max_tokens <= 32768:
            raise ValueError('max_tokens must be an integer between 0 and 32768')
        if not isinstance(draft_size, int) or not 1 <= draft_size <= 128:
            raise ValueError('draft_size must be an integer between 1 and 128')
        raw_stop: object = [stop] if isinstance(stop, str) else (stop or [])
        if not isinstance(raw_stop, list):
            raise ValueError('stop must contain nonempty strings')
        stop_items = cast(list[object], raw_stop)
        if not all(isinstance(value, str) and value for value in stop_items):
            raise ValueError('stop must contain nonempty strings')
        stop_values = cast(list[str], stop_items)
        cancelled = cancelled or (lambda: False)
        # Each request thread gets its own stream; model locks protect KV state.
        with self.lock, self.allocator.session(), mx.stream(self.stream):
            pending_error = None
            try:
                notification = ({'on_no_edit_impossible': on_no_edit_impossible}
                                if on_no_edit_impossible is not None else {})
                result = self._generate(prompt, max_tokens, stop_values, mode, draft_size, cancelled,
                                        on_first_token, **notification)
            except GenerationCancelled as error:
                pending_error = error
                # Checkpoints follow synchronized KV updates and token bookkeeping.
                raise
            except BaseException as error:
                pending_error = error
                # A failed lazy forward may have advanced only some layer offsets.
                self.cache = make_prompt_cache(self.model)
                self.cached_tokens = []
                raise
            finally:
                # Reclaim free buffers on success, cancellation and errors.
                # Only this invocation's exception may suppress cleanup errors;
                # the caller can itself be running inside an except block.
                try:
                    if pending_error is not None:
                        # Unwound frames can retain temporary GPU arrays. Keep
                        # their traceback locations, but release their locals.
                        clear_exception_frames(pending_error)
                    try:
                        self._release_request_state()
                        self._reclaim_cache()
                    except Exception as cleanup_error:
                        if pending_error is None:
                            raise
                        pending_error.add_note(f'Allocator cleanup failed: {cleanup_error}')
                finally:
                    # Avoid retaining our own frame through the exception's traceback.
                    del pending_error
            result['memory'] = self.memory_snapshot()
            return result

    def _generate(self, prompt: str, max_tokens: int, stop: Sequence[str],
                  mode: Literal['source', 'greedy'], draft_size: int,
                  cancelled: CancellationCheck, on_first_token: TokenCallback | None,
                  on_no_edit_impossible: TokenCallback | None = None) -> GenerationResult:
        prompt_tokens: TokenSequence = list(self.tokenizer.encode(prompt))
        if not prompt_tokens:
            raise ValueError('prompt must encode to at least one token')
        if len(prompt_tokens) + max_tokens > self.context_length:
            raise ValueError(
                f'prompt tokens ({len(prompt_tokens)}) plus max_tokens ({max_tokens}) '
                f'exceed context_length ({self.context_length})')
        common = 0
        for old, new in zip(self.cached_tokens, prompt_tokens[:-1]):
            if old != new:
                break
            common += 1
        trim_prompt_cache(self.cache, len(self.cached_tokens) - common)
        self.cached_tokens = self.cached_tokens[:common]
        # Chunk prefill bounds temporary activation memory and permits cancellation.
        suffix = prompt_tokens[common:]
        if not suffix:
            raise RuntimeError('prompt must leave an uncached token for next-token prediction')
        logits: mx.array | None = None
        with span_scope('decoder.prefill'):
            for offset in range(0, len(suffix), PREFILL_STEP_SIZE):
                if cancelled():
                    raise GenerationCancelled('Request cancelled')
                chunk = suffix[offset:offset + PREFILL_STEP_SIZE]
                logits = self._prefill(chunk)
                _eval_array(logits)
                self.cached_tokens.extend(chunk)
            if logits is None:
                raise RuntimeError('prefill must produce logits')
            next_token = int(cast(int, mx.argmax(logits[0, -1]).item()))
        lookup = PromptLookup([prompt_tokens]) if mode == 'source' else None
        eos: set[int] = set(getattr(self.tokenizer, 'eos_token_ids', []))
        if not eos and self.tokenizer.eos_token_id is not None:
            eos.add(self.tokenizer.eos_token_id)
        generated: TokenSequence = []
        text, finish = '', 'length'
        forwards = proposed = accepted = zero_accepts = 0
        with span_scope('decoder.decode'):
            while len(generated) < max_tokens:
                if cancelled():
                    raise GenerationCancelled('Request cancelled')
                # The final pending token has not been inserted into the KV cache yet.
                if next_token in eos:
                    finish = 'stop'
                    break
                remaining = max_tokens - len(generated)
                history: TokenSequence = prompt_tokens + generated + [next_token]
                draft = lookup.propose(history, min(draft_size, remaining - 1)) if lookup else []
                batch: TokenSequence = [next_token] + draft
                predictions = mx.argmax(self.model(mx.array([batch]), cache=self.cache)[0], axis=-1)
                _eval_array(predictions)
                predictions = cast(TokenSequence, predictions.tolist())
                forwards += 1
                proposed += len(draft)
                matched = 0
                while matched < len(draft) and draft[matched] == predictions[matched]:
                    matched += 1
                zero_accepts += bool(draft) and matched == 0
                committed = batch[:matched + 1]
                trim_prompt_cache(self.cache, len(batch) - len(committed))
                self.cached_tokens.extend(committed)
                accepted += matched
                next_token = predictions[matched]
                for token in committed:
                    if token in eos:
                        finish = 'stop'
                        break
                    generated.append(token)
                    if len(generated) == 1:
                        trace.get_current_span().add_event('first_token')
                        if on_first_token is not None:
                            on_first_token()
                    text = self.tokenizer.decode(generated)
                    stops = [text.find(s) for s in stop if s in text]
                    if stops:
                        text = text[:min(stops)]
                        finish = 'stop'
                    if on_no_edit_impossible is not None:
                        # A not-yet-complete stop may later truncate this suffix.
                        # Classify only text guaranteed to survive that truncation.
                        partial_stop = max((length for value in stop
                                            for length in range(1, min(len(value), len(text)) + 1)
                                            if text.endswith(value[:length])), default=0)
                        candidate = text[:-partial_stop] if partial_stop else text
                        if not is_no_edit_prefix(candidate):
                            on_no_edit_impossible()
                            on_no_edit_impossible = None
                    if stops:
                        break
                if finish == 'stop':
                    break
        result: GenerationResult = {
            'text': text,
            'finish_reason': finish,
            'tokens': generated,
            'usage': {
                'prompt_tokens': len(prompt_tokens),
                'completion_tokens': len(generated),
                'total_tokens': len(prompt_tokens) + len(generated),
            },
            'cache': {'cached_prompt_tokens': common},
            'draft_stats': {
                'forward_passes': forwards,
                'proposed_tokens': proposed,
                'accepted_tokens': accepted,
                'zero_accept_batches': zero_accepts,
            },
            'prompt_sha256': hashlib.sha256(prompt.encode()).hexdigest(),
        }
        return result


def main() -> None:
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--corpus', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--draft-size', type=int, default=96)
    parser.add_argument('--context-length', type=int)
    parser.add_argument('--cache-limit-mb', type=nonnegative_int, default=256)
    args = parser.parse_args()
    print(json.dumps(dict(pid=os.getpid(), phase='loading')), flush=True)
    decoder = Decoder(args.model, context_length=args.context_length,
                      cache_limit_mb=args.cache_limit_mb)
    with open(args.corpus) as corpus_file:
        cases = json.load(corpus_file)['cases']
    results: list[dict[str, object]] = []
    for case in cases:
        for mode in ('greedy', 'source'):
            result = decoder.generate(case['prompt'], max_tokens=case.get('maxTokens', 2048),
                                      stop=case.get('stopTokens'), mode=mode,
                                      draft_size=args.draft_size)
            benchmark_result: dict[str, object] = dict(result)
            benchmark_result.update(case_id=case['id'], mode=mode)
            results.append(benchmark_result)
            fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w') as handle:
                json.dump(results, handle)
            print(json.dumps({k: v for k, v in result.items() if k not in ('text', 'tokens')}), flush=True)


if __name__ == '__main__':
    main()
