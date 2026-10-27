"""Buffered raw Qwen FIM decoding, independent of Zeta's source verifier."""
from collections.abc import Callable, Sequence
from typing import Literal, cast

from observability import span_scope
from opentelemetry import trace

import mlx.core as mx
from mlx_lm.models.cache import trim_prompt_cache
from mlx_lm.sample_utils import make_logits_processors, make_sampler

from decoder import Decoder, GenerationCancelled, PREFILL_STEP_SIZE
from typing_contracts import CancellationCheck, GenerationResult, TokenCallback


REPETITION_CONTEXT_SIZE = 20


def _eval_array(value: mx.array) -> None:
    # MLX's eval stub has an untyped variadic signature; keep the narrow wrapper typed.
    evaluate = cast(Callable[[mx.array], None], getattr(mx, 'eval'))
    evaluate(value)


def _async_eval_array(value: mx.array) -> None:
    evaluate = cast(Callable[[mx.array], None], getattr(mx, 'async_eval'))
    evaluate(value)


class ContinuationDecoder(Decoder):
    def _prefill_token(self, token: mx.array) -> mx.array:
        # Keep the sampled token on device. A single-token public model call
        # already projects only the required position, including tied heads.
        return self.model(mx.reshape(token, (1, 1)), cache=self.cache)

    def generate(self, prompt: object, max_tokens: object = 192,
                 stop: object = None,
                 mode: Literal['source', 'greedy'] | CancellationCheck = 'greedy',
                 draft_size: object = 96,
                 cancelled: CancellationCheck | None = None,
                 on_first_token: TokenCallback | None = None,
                 on_no_edit_impossible: TokenCallback | None = None) -> GenerationResult:
        if not isinstance(prompt, str):
            raise ValueError('prompt must be a raw Qwen FIM string')
        markers = ('<|fim_prefix|>', '<|fim_suffix|>', '<|fim_middle|>')
        if (not prompt.startswith(markers[0]) or not prompt.endswith(markers[2])
                or any(prompt.count(marker) != 1 for marker in markers)
                or prompt.index(markers[1]) < len(markers[0])):
            raise ValueError('prompt must contain one ordered Qwen FIM prefix, suffix and middle')
        if type(max_tokens) is not int or not 0 <= max_tokens <= 512:
            raise ValueError('Qwen max_tokens must be an integer between 0 and 512')
        if callable(mode):
            cancelled = mode
        return super().generate(prompt, max_tokens=max_tokens, stop=stop, mode='greedy',
                                draft_size=draft_size, cancelled=cancelled,
                                on_first_token=on_first_token,
                                on_no_edit_impossible=on_no_edit_impossible)

    def _generate(self, prompt: str, max_tokens: int, stop: Sequence[str],
                  mode: Literal['source', 'greedy'], draft_size: int,
                  cancelled: CancellationCheck, on_first_token: TokenCallback | None,
                  on_no_edit_impossible: TokenCallback | None = None) -> GenerationResult:
        # Keep the caller's raw FIM tokens; no chat template or automatic BOS.
        prompt_tokens = self.tokenizer.encode(prompt, add_special_tokens=False)
        if not prompt_tokens:
            raise ValueError('prompt must encode to at least one token')
        if len(prompt_tokens) + max_tokens > self.context_length:
            raise ValueError('Qwen prompt plus max_tokens exceeds context_length')
        # Reuse only identical prompt tokens, leaving one token for fresh logits.
        # Qwen's decoder owns this cache independently of Zeta's prefix state.
        common = 0
        for old, new in zip(self.cached_tokens, prompt_tokens[:-1]):
            if old != new:
                break
            common += 1
        trim_prompt_cache(self.cache, len(self.cached_tokens) - common)
        self.cached_tokens = self.cached_tokens[:common]
        suffix = prompt_tokens[common:]
        sampler = make_sampler(0)
        processors = make_logits_processors(
            repetition_penalty=1.1, repetition_context_size=REPETITION_CONTEXT_SIZE)
        # The pinned repetition processor only reads this trailing window.
        history = mx.array(prompt_tokens[-REPETITION_CONTEXT_SIZE:])

        def sample_next(logits: mx.array, history: mx.array) -> mx.array:
            scores = logits[:, -1, :]
            for processor in processors:
                scores = processor(history, scores)
            # Temperature-zero argmax is invariant to log-softmax normalization.
            return sampler(scores)

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
            raise RuntimeError('Qwen prefill must produce logits')
        eos: set[int] = set(getattr(self.tokenizer, 'eos_token_ids', []))
        if not eos and self.tokenizer.eos_token_id is not None:
            eos.add(self.tokenizer.eos_token_id)
        generated: list[int] = []
        text, finish = '', 'length'
        pending_token: int | None = None
        uncommitted_inputs = 0
        work_pending = False
        with span_scope('decoder.decode'):
            try:
                sampled = sample_next(logits, history) if max_tokens else None
                if sampled is not None:
                    work_pending = True
                    _async_eval_array(sampled)
                while len(generated) < max_tokens:
                    if cancelled():
                        if pending_token is not None:
                            # Finish and record the preceding known input before
                            # exposing cancellation as a safe cache checkpoint.
                            mx.synchronize(self.stream)
                            self.cached_tokens.append(pending_token)
                            uncommitted_inputs -= 1
                            pending_token = None
                            work_pending = False
                        raise GenerationCancelled('Request cancelled')
                    assert sampled is not None
                    next_sample: mx.array | None = None
                    next_history = history
                    if len(generated) + 1 < max_tokens:
                        next_history = mx.concatenate([history, sampled])[-REPETITION_CONTEXT_SIZE:]
                        next_logits = self._prefill_token(sampled)
                        uncommitted_inputs += 1
                        next_sample = sample_next(next_logits, next_history)
                        # Build and submit the next graph before materializing
                        # the current token, overlapping host work with the GPU.
                        work_pending = True
                        _async_eval_array(next_sample)
                    _eval_array(sampled)
                    token = int(cast(int, sampled.item()))
                    if pending_token is not None:
                        # The current sample depends on this preceding forward.
                        self.cached_tokens.append(pending_token)
                        uncommitted_inputs -= 1
                    pending_token = token if next_sample is not None else None
                    work_pending = next_sample is not None
                    if token in eos:
                        finish = 'stop'
                        break
                    generated.append(token)
                    if len(generated) == 1:
                        trace.get_current_span().add_event('first_token')
                        if on_first_token is not None:
                            on_first_token()
                    text = self.tokenizer.decode(generated)
                    stops = [text.find(value) for value in stop if value in text]
                    if stops:
                        text = text[:min(stops)]
                        finish = 'stop'
                        break
                    if next_sample is not None:
                        history = next_history
                    sampled = next_sample
            finally:
                if work_pending:
                    # Stop/EOS, callbacks or errors may leave work in flight.
                    # Drain before trimming any uncommitted KV inputs (at most
                    # two while building a graph). Failed drains invalidate via
                    # Decoder.generate rather than escaping as safe cancellation.
                    mx.synchronize(self.stream)
                if uncommitted_inputs:
                    trim_prompt_cache(self.cache, uncommitted_inputs)
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
        }
        return result
