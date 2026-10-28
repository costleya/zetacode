"""CPU-only contract tests. Run: server/.venv/bin/python -m unittest discover -s server/tests -v."""

from __future__ import annotations

import gc
from contextlib import ExitStack, contextmanager, nullcontext
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import io
from pathlib import Path
import sys
import types
import threading
import unittest
import weakref
from typing import Any, cast
from unittest.mock import Mock, mock_open, patch
from importlib.machinery import ModuleSpec

from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter


class Scalar(int):
    def item(self) -> int:
        return int(self)


class Predictions(list[int]):
    def tolist(self) -> list[int]:
        return list(self)


class Logits:
    """Only the indexing and argmax surface the decoder consumes."""

    def __init__(self, winners: list[int]) -> None:
        self.winners = winners

    def __getitem__(self, index: int | tuple[int, int]) -> Scalar | Predictions:
        if index == (0, -1):
            return Scalar(self.winners[-1])
        if index == 0:
            return Predictions(self.winners)
        raise AssertionError(f"Unexpected logits index: {index!r}")


class Cache:
    def __init__(self) -> None:
        self.tokens: list[int] = []
        self.trims: list[int] = []

    @property
    def nbytes(self):
        return 8 * len(self.tokens)

    def is_trimmable(self):
        return True


def trim_cache(caches: list[Cache], count: int) -> None:
    for cache in caches:
        if count < 0 or count > len(cache.tokens):
            raise AssertionError(f"Invalid cache trim: {count}")
        cache.trims.append(count)
        if count:
            del cache.tokens[-count:]


class Tokenizer:
    eos_token_ids = [0]
    eos_token_id = 0

    def encode(self, text: str) -> list[int]:
        return list(map(ord, text))

    def decode(self, tokens: list[int]) -> str:
        return "".join(map(chr, tokens))


class TargetModel:
    """A causal target oracle, including predictions after an incorrect draft.

    Responses are specified by the test, independently of the lookup algorithm.
    An incorrect output prefix produces '?' forever, exposing stale KV tokens.
    """

    args: Any
    model_type: str
    model: Any
    lm_head: Any

    def __init__(self, responses: dict[str, str]) -> None:
        self.responses = responses
        self.calls: list[list[int]] = []

    def __call__(self, inputs: tuple[list[int]], cache: list[Cache]) -> Logits:
        batch, = inputs
        self.calls.append(list(batch))
        winners: list[int] = []
        for token in batch:
            cache[0].tokens.append(token)
            context = Tokenizer().decode(cache[0].tokens)
            prompt, separator, emitted = context.partition("|")
            if not separator:
                winners.append(ord("?"))
                continue
            expected = self.responses[prompt + separator]
            if not expected.startswith(emitted):
                winners.append(ord("?"))
            elif len(emitted) == len(expected):
                winners.append(0)
            else:
                winners.append(ord(expected[len(emitted)]))
        return Logits(winners)


def load_decoder():
    # Keep fake MLX local to this import; do not require or shadow an installed runtime.
    core = cast(Any, types.ModuleType("mlx.core"))
    def identity(value: object) -> object:
        return value

    def discard(*values: object) -> None:
        return None

    def argmax(value: object, axis: int | None = None) -> object:
        return value

    def zero() -> int:
        return 0

    def stream_factory(device: object) -> object:
        return object()

    def stream_context(stream: object) -> Any:
        return nullcontext()

    core.array = identity
    core.eval = discard
    core.argmax = argmax
    core.set_cache_limit = discard
    core.get_active_memory = zero
    core.get_cache_memory = zero
    core.get_peak_memory = zero
    core.synchronize = discard
    core.clear_cache = discard
    core.gpu = object()
    core.new_thread_local_stream = stream_factory
    core.stream = stream_context
    mlx = cast(Any, types.ModuleType("mlx"))
    mlx.core = core
    lm = cast(Any, types.ModuleType("mlx_lm"))
    def fake_load(path: str) -> None:
        return None

    def make_prompt_cache(model: object) -> list[Cache]:
        return [Cache()]

    lm.load = fake_load
    caches = cast(Any, types.ModuleType("mlx_lm.models.cache"))
    caches.make_prompt_cache = make_prompt_cache
    caches.trim_prompt_cache = trim_cache
    modules = {"mlx": mlx, "mlx.core": core, "mlx_lm": lm,
               "mlx_lm.models": types.ModuleType("mlx_lm.models"),
               "mlx_lm.models.cache": caches}
    source = Path(__file__).resolve().parents[1] / "src"
    spec = cast(ModuleSpec, importlib.util.spec_from_file_location(
        "zeta_decoder_contract", source / "decoder.py"))
    module = importlib.util.module_from_spec(spec)
    with patch.object(sys, "path", [str(source), *sys.path]):
        import observability
        with patch.dict(sys.modules, {**modules, "observability": observability}):
            cast(Any, spec.loader).exec_module(module)
    return module


decoder_module = load_decoder()


class ResidencyTests(unittest.TestCase):
    @contextmanager
    def runtime(self, active: int | str = 4 * 1024**3, ram: int | str = 64 * 1024**3,
                recommended: int | str = 48 * 1024**3) -> Any:
        mx = types.SimpleNamespace(
            gpu=object(), metal=types.SimpleNamespace(is_available=lambda: True),
            get_active_memory=Mock(return_value=active),
            device_info=Mock(return_value={'max_recommended_working_set_size': recommended}),
            set_cache_limit=Mock(), set_wired_limit=Mock())
        with ExitStack() as stack:
            stack.enter_context(patch.object(decoder_module, 'mx', mx))
            stack.enter_context(patch.object(sys, 'platform', 'darwin'))
            stack.enter_context(patch.object(decoder_module.platform, 'mac_ver',
                                            return_value=('15.0', ('', '', ''), 'arm64')))
            capacity = {'SC_PHYS_PAGES': ram, 'SC_PAGE_SIZE': 1}
            stack.enter_context(patch.object(decoder_module.os, 'sysconf',
                                            side_effect=capacity.__getitem__))
            yield mx

    def test_budget_is_bounded_by_resident_memory_ram_and_recommended_working_set(self):
        gib = 1024**3
        for active, ram, recommended, expected in (
                (4 * gib, 64 * gib, 48 * gib, 4 * gib + 256 * 1024**2),
                (20 * gib, 32 * gib, 48 * gib, 8 * gib),
                (20 * gib, 64 * gib, 12 * gib, 6 * gib)):
            with self.subTest(active=active, ram=ram, recommended=recommended), \
                    self.runtime(active, ram, recommended) as mx:
                allocator = decoder_module.MLXAllocator()
                with patch('sys.stdout', new_callable=io.StringIO) as output:
                    allocator.configure_residency('1000')
                mx.set_wired_limit.assert_called_once_with(expected)
                mx.set_cache_limit.assert_called_once_with(256 * 1024**2)
                self.assertEqual(decoder_module.json.loads(output.getvalue()), {
                    'mlx_residency': {'wired_limit_bytes': expected, 'refresh_interval_ms': 1000}})

    def test_budget_uses_the_existing_custom_allocator_cache_limit(self):
        with self.runtime() as mx:
            with patch('sys.stdout', new_callable=io.StringIO):
                decoder_module.MLXAllocator(cache_limit_mb=17).configure_residency('2500')
            mx.set_wired_limit.assert_called_once_with(4 * 1024**3 + 17 * 1024**2)
            mx.set_cache_limit.assert_called_once_with(17 * 1024**2)

    def test_explicit_zero_skips_new_wiring_and_capacity_probes(self):
        with self.runtime() as mx:
            decoder_module.MLXAllocator().configure_residency('0')
            mx.set_wired_limit.assert_not_called()
            mx.get_active_memory.assert_not_called()
            mx.device_info.assert_not_called()

    def test_missing_residency_apis_warn_and_continue(self):
        for missing in ('set_wired_limit', 'device_info', 'get_active_memory', 'metal'):
            with self.subTest(missing=missing), self.runtime() as mx:
                allocator = decoder_module.MLXAllocator()
                delattr(mx, missing)
                with self.assertLogs(level='WARNING'):
                    allocator.configure_residency('1000')
                if missing != 'set_wired_limit':
                    mx.set_wired_limit.assert_not_called()

    def test_invalid_capacity_warns_without_wiring(self):
        for changes in ({'ram': 0}, {'ram': -1}, {'recommended': 0},
                        {'recommended': -1}, {'active': -1}, {'active': 'unknown'}):
            with self.subTest(changes=changes), self.runtime(**changes) as mx:
                allocator = decoder_module.MLXAllocator()
                with self.assertLogs(level='WARNING'):
                    allocator.configure_residency('1000')
                mx.set_wired_limit.assert_not_called()

    def test_unsupported_platform_warns_without_wiring(self):
        for system, version, metal in (('linux', '15.0', True),
                                       ('darwin', '14.7', True),
                                       ('darwin', '15.0', False)):
            with self.subTest(system=system, version=version, metal=metal), self.runtime() as mx:
                allocator = decoder_module.MLXAllocator()
                mx.metal.is_available = lambda: metal
                with patch.object(sys, 'platform', system), \
                        patch.object(decoder_module.platform, 'mac_ver',
                                     return_value=(version, ('', '', ''), 'arm64')), \
                        self.assertLogs(level='WARNING'):
                    allocator.configure_residency('1000')
                mx.set_wired_limit.assert_not_called()

    def test_invalid_interval_and_unavailable_ram_warn_and_continue(self):
        with self.runtime() as mx:
            allocator = decoder_module.MLXAllocator()
            with self.assertLogs(level='WARNING'):
                allocator.configure_residency('invalid')
            with patch.object(decoder_module.os, 'sysconf', side_effect=OSError('unavailable')), \
                    self.assertLogs(level='WARNING'):
                allocator.configure_residency('1000')
            mx.set_wired_limit.assert_not_called()

    def test_capacity_and_wiring_failures_warn_and_continue(self):
        for failing in ('device_info', 'get_active_memory', 'set_wired_limit'):
            with self.subTest(failing=failing), self.runtime() as mx:
                allocator = decoder_module.MLXAllocator()
                getattr(mx, failing).side_effect = RuntimeError('unavailable')
                with self.assertLogs(level='WARNING'):
                    allocator.configure_residency('1000')
                mx.set_cache_limit.assert_called_once_with(256 * 1024**2)


class PromptLookupTests(unittest.TestCase):
    def test_requires_matching_suffix_and_continuation(self):
        lookup = decoder_module.PromptLookup([[1, 2, 3, 4], [8, 9, 10]])
        for history in ([], [2], [7, 2], [3, 4], [9, 10]):
            with self.subTest(history=history):
                self.assertEqual(lookup.propose(history, 10), [])
        self.assertEqual(lookup.propose([8, 1, 2], 10), [3, 4])
        self.assertEqual(lookup.propose([8, 9], 1), [10])
        self.assertEqual(lookup.propose([1, 2], 0), [])

    def test_longest_history_match_wins_over_longer_continuation(self):
        lookup = decoder_module.PromptLookup([[9, 2, 3, 40, 41, 42], [1, 2, 3, 50]])
        self.assertEqual(lookup.propose([8, 1, 2, 3], 10), [50])

    def test_ngram_cap_and_draft_cap(self):
        sources = [[9, 2, 3, 40, 41, 42], [1, 2, 3, 50]]
        lookup = decoder_module.PromptLookup(sources, max_ngram=2)
        self.assertEqual(lookup.propose([1, 2, 3], 2), [40, 41])

    def test_equal_matches_prefer_latest_source_and_latest_occurrence(self):
        sources = [[1, 2, 3, 4, 50, 51], [9, 2, 3, 4, 60, 61]]
        lookup = decoder_module.PromptLookup(sources)
        self.assertEqual(lookup.propose([2, 3, 4], 2), [60, 61])
        # A stronger earlier match still wins over the newer source.
        self.assertEqual(lookup.propose([1, 2, 3, 4], 2), [50, 51])
        lookup = decoder_module.PromptLookup([[1, 2, 3, 4, 50, 51, 1, 2, 3, 4, 60, 61]])
        self.assertEqual(lookup.propose([1, 2, 3, 4], 2), [60, 61])

    def test_every_proposal_is_a_known_source_continuation(self):
        sources = [[1, 2, 3, 1, 2, 4], [8, 1, 2, 5, 6]]
        lookup = decoder_module.PromptLookup(sources)
        for history in ([1, 2], [7, 1, 2], [8, 1, 2], [2, 3], [5, 6]):
            for count in range(1, 8):
                proposal = lookup.propose(history, count)
                self.assertLessEqual(len(proposal), count)
                if proposal:
                    self.assertTrue(any(
                        source[end - 2:end] == history[-2:]
                        and source[end:end + len(proposal)] == proposal
                        for source in sources for end in range(2, len(source))))


class DecoderTests(unittest.TestCase):
    def make_decoder(self, responses: dict[str, str], model_context: int | None = None,
                     context_length: Any = None, allocator: Any = None) -> tuple[Any, TargetModel]:
        model = TargetModel(responses)
        if model_context is not None:
            model.args = types.SimpleNamespace(max_position_embeddings=model_context)
        with patch.object(decoder_module, "load", return_value=(model, Tokenizer())):
            options = {} if context_length is None else {"context_length": context_length}
            if allocator is not None:
                options["allocator"] = allocator
            decoder = decoder_module.Decoder("fake-model", **options)
        return decoder, model

    def assert_response(self, result: dict[str, Any], prompt: str, expected: str,
                        finish: str = "stop") -> None:
        self.assertEqual(result["text"], expected)
        self.assertEqual(result["tokens"], list(map(ord, expected)))
        self.assertEqual(result["finish_reason"], finish)
        self.assertEqual(result["usage"], {
            "prompt_tokens": len(prompt), "completion_tokens": len(expected),
            "total_tokens": len(prompt) + len(expected)})

    def test_generate_records_ended_prefill_and_decode_spans_without_timing_output(self):
        source = Path(__file__).resolve().parents[1] / "src"
        with patch.object(sys, "path", [str(source), *sys.path]):
            import observability

        observability.shutdown_tracing()
        exporter = InMemorySpanExporter()
        provider = TracerProvider()
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        observability.configure_tracing(provider)
        try:
            prompt = "prompt|"
            decoder, _ = self.make_decoder({prompt: "answer"})
            result = decoder.generate(prompt)

            self.assertEqual(result["cache"], {"cached_prompt_tokens": 0})
            self.assertNotIn("timings", result)
            spans = exporter.get_finished_spans()
            self.assertEqual({span.name for span in spans}, {
                "decoder.prefill", "decoder.decode"})
            self.assertTrue(all(cast(dict[str, Any], span.attributes)["nesweep.outcome"] == "success"
                                for span in spans))
        finally:
            observability.shutdown_tracing()

    def test_fully_accepted_draft_matches_greedy_and_uses_fewer_calls(self):
        prompt, expected = "abcdefghij!|", "abcdefghij!"
        decoder, model = self.make_decoder({prompt: expected})
        greedy = decoder.generate(prompt, mode="greedy", max_tokens=len(expected))
        model.calls.clear()
        source = decoder.generate(prompt, mode="source", draft_size=8,
                                  max_tokens=len(expected))
        self.assert_response(greedy, prompt, expected, "length")
        self.assert_response(source, prompt, expected, "length")
        self.assertGreater(source["draft_stats"]["accepted_tokens"], 0)
        self.assertEqual(source["draft_stats"]["accepted_tokens"],
                         source["draft_stats"]["proposed_tokens"])
        self.assertLess(source["draft_stats"]["forward_passes"],
                        greedy["draft_stats"]["forward_passes"])
        self.assertTrue(any(len(batch) > 1 for batch in model.calls[1:]))

    def test_partial_acceptance_rolls_back_rejected_tokens(self):
        prompt, expected = "abcdef!|", "abcXef!"
        decoder, _ = self.make_decoder({prompt: expected})
        result = decoder.generate(prompt, draft_size=6)
        self.assert_response(result, prompt, expected)
        stats = result["draft_stats"]
        self.assertGreater(stats["accepted_tokens"], 0)
        self.assertGreater(stats["proposed_tokens"], stats["accepted_tokens"])
        self.assertTrue(any(count > 0 for count in decoder.cache[0].trims))
        self.assertEqual(decoder.cache[0].tokens, decoder.cached_tokens)
        self.assertEqual(decoder.cached_tokens, list(map(ord, prompt + expected)))

    def test_immediately_rejected_draft_still_emits_target_tokens(self):
        prompt, expected = "abcdef!|", "abXYZ!"
        decoder, _ = self.make_decoder({prompt: expected})
        result = decoder.generate(prompt)
        self.assert_response(result, prompt, expected)
        self.assertGreater(result["draft_stats"]["proposed_tokens"], 0)
        self.assertEqual(result["draft_stats"]["accepted_tokens"], 0)

    def test_mismatch_at_each_draft_position_preserves_entire_target_output(self):
        source = "abcdefghijklmnop!"
        prompt = source + "|"
        for position in range(2, len(source)):
            expected = source[:position] + "X" + source[position + 1:]
            with self.subTest(position=position):
                decoder, _ = self.make_decoder({prompt: expected})
                self.assert_response(decoder.generate(prompt, draft_size=12), prompt, expected)
                self.assertEqual(decoder.cache[0].tokens, decoder.cached_tokens)

    def test_output_larger_than_a_draft_is_returned_in_full(self):
        expected = "abcdefghij" * 30 + "!"
        prompt = expected + "|"
        decoder, _ = self.make_decoder({prompt: expected})
        self.assert_response(decoder.generate(prompt, draft_size=24), prompt, expected)

    def test_llama_prefill_preserves_target_output_for_both_embedding_modes(self):
        class Hidden:
            def __init__(self, winners: list[int]) -> None:
                self.winners = winners

            def __getitem__(self, index: tuple[Any, ...]) -> Hidden:
                positions = cast(slice, index[1])
                return Hidden(self.winners[positions])

        class Backbone:
            def __init__(self, target: TargetModel) -> None:
                self.target = target
                self.embed_tokens = types.SimpleNamespace(as_linear=self.project)

            def __call__(self, inputs: tuple[list[int]], cache: list[Cache]) -> Hidden:
                return Hidden(TargetModel.__call__(self.target, inputs, cache).winners)

            @staticmethod
            def project(hidden: Hidden) -> Logits:
                return Logits(hidden.winners)

        prompt, expected = "abcdef!|", "abcXef!"
        for tied in (False, True):
            with self.subTest(tied=tied):
                decoder, model = self.make_decoder({prompt: expected})
                model.model_type = "llama"
                model.args = types.SimpleNamespace(tie_word_embeddings=tied)
                model.model = Backbone(model)
                model.lm_head = Backbone.project
                self.assert_response(decoder.generate(prompt), prompt, expected)
                self.assert_response(decoder.generate(prompt, mode="greedy"), prompt, expected)

    def test_token_budget_never_truncates_a_token_or_overruns_a_batch(self):
        prompt, expected = "abcdef!|", "abcdef!"
        for limit in (0, 1, 2, 3, 5):
            with self.subTest(limit=limit):
                decoder, _ = self.make_decoder({prompt: expected})
                result = decoder.generate(prompt, max_tokens=limit)
                self.assert_response(result, prompt, expected[:limit], "length")
                self.assertEqual(decoder.cache[0].tokens, decoder.cached_tokens)

    def test_eos_is_not_emitted_even_when_proposed_by_lookup(self):
        prompt, expected = "ab\0junk|", "ab"
        decoder, _ = self.make_decoder({prompt: expected})
        result = decoder.generate(prompt)
        self.assert_response(result, prompt, expected)
        self.assertNotIn(0, result["tokens"])

    def test_first_token_callback_runs_after_verification_and_only_once(self):
        prompt, expected = "abcdefghij!|", "abcdefghij!"
        decoder, model = self.make_decoder({prompt: expected})
        callback_observations: list[tuple[list[list[int]], list[int], list[int]]] = []

        def on_first_token():
            callback_observations.append((list(model.calls), list(decoder.cached_tokens),
                                          list(decoder.cache[0].tokens)))

        result = decoder.generate(prompt, mode="source", draft_size=8,
                                  max_tokens=len(expected), on_first_token=on_first_token)

        self.assert_response(result, prompt, expected, "length")
        self.assertEqual(len(callback_observations), 1)
        calls, cached_tokens, cache_tokens = callback_observations[0]
        self.assertTrue(calls)
        self.assertEqual(cache_tokens, cached_tokens)
        self.assertEqual(cached_tokens, list(map(ord, prompt + expected[:1])))

    def test_first_token_callback_skips_eos_zero_budget_and_prefill_cancellation(self):
        cases: tuple[tuple[str, str, str, dict[str, Any], str], ...] = (
            ("immediate eos", "prompt|", "", {}, "normal"),
            ("zero budget", "prompt|", "answer", {"max_tokens": 0}, "normal"),
            ("cancelled during prefill", "prompt|", "answer", {"cancelled": lambda: True},
             "cancelled"),
        )
        for name, prompt, expected, options, outcome in cases:
            with self.subTest(name=name):
                decoder, _ = self.make_decoder({prompt: expected})
                callbacks: list[bool] = []
                options = {**options, "on_first_token": lambda: callbacks.append(True)}
                if outcome == "cancelled":
                    with self.assertRaises(decoder_module.GenerationCancelled):
                        decoder.generate(prompt, **options)
                else:
                    decoder.generate(prompt, **options)
                self.assertEqual(callbacks, [])

    def test_no_edit_impossible_preserves_every_incremental_sentinel_prefix(self):
        eos = "<[end▁of▁sentence]>"
        for mode in ("greedy", "source"):
            for text in ("<|marker_1|><|marker_1|>",
                         " \t\n<|marker_00123|> \r\n<|marker_00123|>\t ",
                         "\u00a0\ufeff<|marker_99|>\ufeff<|marker_99|> " + eos + "\n\ufeff"):
                with self.subTest(mode=mode, text=text):
                    prompt = "prompt|"
                    # Run every finite prefix, not just a completed sentinel.
                    # A partial marker, digits, or EOS must remain possible.
                    for count in range(len(text) + 1):
                        decoder, _ = self.make_decoder({prompt: text})
                        callbacks: list[bool] = []
                        result = decoder.generate(
                            prompt, mode=mode, max_tokens=count,
                            on_no_edit_impossible=lambda: callbacks.append(True))
                        self.assertEqual(result["text"], text[:count])
                        self.assertEqual(callbacks, [], (mode, text[:count]))

    def test_no_edit_impossible_signals_once_after_synchronized_commit(self):
        marker = "<|marker_1|>"
        for text, first_impossible in (("ordinary invalid output", 1),
                                       (marker + "replacement", len(marker) + 1),
                                       (marker + "<|marker_2|>", len(marker) + len("<|marker_2")),
                                       (marker * 2 + "x", len(marker) * 2 + 1)):
            for mode in ("greedy", "source"):
                with self.subTest(text=text, mode=mode):
                    prompt = text + "|" if "|" not in text else "prompt|"
                    decoder, _ = self.make_decoder({prompt: text})
                    events: list[tuple[str, int]] = []
                    syncs: list[bool] = []

                    def record_sync(*_values: object) -> None:
                        syncs.append(True)

                    def impossible():
                        self.assertTrue(syncs)
                        self.assertEqual(decoder.cache[0].tokens, decoder.cached_tokens)
                        events.append(("impossible", len(decoder.cached_tokens) - len(prompt)))

                    with patch.object(decoder_module.mx, "eval", side_effect=record_sync):
                        result = decoder.generate(
                            prompt, mode=mode, max_tokens=len(text),
                            on_first_token=lambda: events.append(("first", 1)),
                            on_no_edit_impossible=impossible)
                    self.assert_response(result, prompt, text, "length")
                    self.assertEqual([name for name, _ in events], ["first", "impossible"])
                    if mode == "greedy":
                        self.assertEqual(events[1][1], first_impossible)

    def test_custom_stop_and_its_partial_suffix_never_cancel_valid_no_edit(self):
        sentinel = "<|marker_1|> <|marker_1|>"
        for mode in ("greedy", "source"):
            for stop in ("X", "STOP", "<CUSTOM>"):
                for prefix_length in range(1, len(stop) + 1):
                    with self.subTest(mode=mode, stop=stop, prefix_length=prefix_length):
                        text = sentinel + stop + "ignored"
                        prompt = "prompt|"
                        decoder, _ = self.make_decoder({prompt: text})
                        callbacks: list[bool] = []
                        result = decoder.generate(
                            prompt, mode=mode, max_tokens=len(sentinel) + prefix_length,
                            stop=["never-matched", stop],
                            on_no_edit_impossible=lambda: callbacks.append(True))
                        expected = (sentinel if prefix_length == len(stop)
                                    else sentinel + stop[:prefix_length])
                        self.assertEqual(result["text"], expected)
                        self.assertEqual(callbacks, [])

    def test_transient_replacement_character_can_complete_to_no_edit_whitespace(self):
        marker = "<|marker_1|>"
        raw = marker + "XY" + marker
        decoder, _ = self.make_decoder({"prompt|": raw})
        decode = decoder.tokenizer.decode
        def decode_transient(ids: list[int]) -> str:
            return decode(ids).replace("XY", "\u00a0").replace("X", "\ufffd")

        decoder.tokenizer.decode = decode_transient
        callbacks: list[bool] = []
        result = decoder.generate("prompt|", mode="greedy", max_tokens=len(raw),
                                  on_no_edit_impossible=lambda: callbacks.append(True))
        self.assertEqual(result["text"], marker + "\u00a0" + marker)
        self.assertEqual(callbacks, [])

    def test_verified_draft_batch_with_no_edit_and_stop_keeps_continuation_possible(self):
        sentinel = "<|marker_1|><|marker_1|>"
        text, prompt = sentinel + "STOPignored", "prompt|"
        decoder, _ = self.make_decoder({prompt: text})
        callbacks: list[bool] = []

        def propose(history: list[int], count: int) -> list[int]:
            # Supply correct drafts independently of prompt lookup selection,
            # so the recognizer sees multiple verified tokens in one batch.
            emitted = len(history) - len(prompt)
            return list(map(ord, text[emitted:emitted + count]))

        with patch.object(decoder_module.PromptLookup, "propose", side_effect=propose):
            result = decoder.generate(prompt, mode="source", max_tokens=len(text), stop="STOP",
                                      on_no_edit_impossible=lambda: callbacks.append(True))
        self.assertGreater(result["draft_stats"]["accepted_tokens"], 0)
        self.assertEqual(result["text"], sentinel)
        self.assertEqual(result["finish_reason"], "stop")
        self.assertEqual(callbacks, [])

    def test_impossible_callback_failure_and_prefill_cancellation_preserve_cleanup(self):
        decoder, _ = self.make_decoder({"prompt|": "edit"})
        error = BrokenPipeError("notification disconnected")

        def impossible():
            raise error

        with self.assertRaises(BrokenPipeError) as caught:
            decoder.generate("prompt|", on_no_edit_impossible=impossible)
        self.assertIs(caught.exception, error)
        self.assertEqual(decoder.cached_tokens, [])
        callbacks: list[bool] = []
        with self.assertRaises(decoder_module.GenerationCancelled):
            decoder.generate("prompt|", cancelled=lambda: True,
                             on_no_edit_impossible=lambda: callbacks.append(True))
        self.assertEqual(callbacks, [])
        self.assertEqual(decoder.generate("prompt|")["text"], "edit")

    def test_stop_string_inside_accepted_batch_and_subsequent_request(self):
        prompt, expected = "abcdef!|", "abcdef!"
        other_prompt = "abcdef! next|"
        decoder, _ = self.make_decoder({prompt: expected, other_prompt: "fresh"})
        result = decoder.generate(prompt, stop=["cde", "ef"])
        self.assertEqual(result["text"], "ab")
        self.assertEqual(result["finish_reason"], "stop")
        self.assertNotIn(ord("f"), result["tokens"])
        self.assert_response(decoder.generate(other_prompt), other_prompt, "fresh")
        self.assert_response(decoder.generate(prompt), prompt, expected)

    def test_reusing_same_and_divergent_prompts_never_reuses_output(self):
        responses = {"abcdef!|": "abcXef!", "abc other|": "other", "new|": "new"}
        decoder, _ = self.make_decoder(responses)
        for prompt in ["abcdef!|", "abcdef!|", "abc other|", "new|", "abcdef!|"]:
            self.assert_response(decoder.generate(prompt), prompt, responses[prompt])
            self.assertEqual(decoder.cache[0].tokens, decoder.cached_tokens)

    def test_cancellation_during_prefill_and_decode_allows_next_request(self):
        prompt = "a" * 600 + "|"
        for cancel_at in (1, 2, 3, 5):
            with self.subTest(cancel_at=cancel_at):
                decoder, _ = self.make_decoder({prompt: "abcdef"})
                checks = 0

                def cancelled():
                    nonlocal checks
                    checks += 1
                    return checks == cancel_at

                with self.assertRaises(InterruptedError):
                    decoder.generate(prompt, cancelled=cancelled)
                self.assertEqual(decoder.cache[0].tokens, decoder.cached_tokens)
                self.assert_response(decoder.generate(prompt), prompt, "abcdef")

    def test_safe_cancellation_preserves_completed_cache_for_next_request(self):
        prompt, expected = "a" * 600 + "|", "abcdef"
        for phase in ("prefill", "decode"):
            with self.subTest(phase=phase):
                decoder, _ = self.make_decoder({prompt: expected})
                original_cache = decoder.cache[0]

                def cancelled():
                    cached = len(original_cache.tokens)
                    return cached > 0 if phase == "prefill" else cached > len(prompt)

                with self.assertRaises(decoder_module.GenerationCancelled):
                    decoder.generate(prompt, cancelled=cancelled)
                self.assertIs(decoder.cache[0], original_cache)
                retained = list(original_cache.tokens)
                self.assertGreater(len(retained), 0)
                if phase == "prefill":
                    self.assertLess(len(retained), len(prompt))
                else:
                    self.assertGreater(len(retained), len(prompt))
                self.assertEqual(retained, decoder.cached_tokens)
                self.assertEqual(retained, list(map(ord, prompt + expected))[:len(retained)])
                resumed = decoder.generate(prompt)
                self.assert_response(resumed, prompt, expected)
                self.assertNotIn("timings", resumed)
                self.assertEqual(resumed["cache"]["cached_prompt_tokens"],
                                 min(len(retained), len(prompt) - 1))
                self.assertEqual(decoder.cache[0].tokens, decoder.cached_tokens)

    def test_first_token_callback_failure_invalidates_cache_but_cancellation_resumes(self):
        prompt, expected = "abcdef!|", "abcXYZ!"
        for error_type in (RuntimeError, decoder_module.GenerationCancelled):
            with self.subTest(error_type=error_type):
                decoder, _ = self.make_decoder({prompt: expected})
                original_cache = decoder.cache[0]
                callbacks: list[bool] = []

                def fail_after_commit():
                    callbacks.append(True)
                    raise error_type("First-token callback failed")

                with self.assertRaises(error_type):
                    decoder.generate(prompt, on_first_token=fail_after_commit)

                self.assertEqual(callbacks, [True])
                if error_type is RuntimeError:
                    self.assertIsNot(decoder.cache[0], original_cache)
                    self.assertEqual(decoder.cached_tokens, [])
                    self.assertEqual(decoder.cache[0].tokens, [])
                    continue

                self.assertIs(decoder.cache[0], original_cache)
                self.assertEqual(decoder.cache[0].tokens, decoder.cached_tokens)
                self.assertEqual(decoder.cached_tokens,
                                 list(map(ord, prompt + expected[:1])))
                self.assert_response(decoder.generate(prompt), prompt, expected)

    def test_unknown_forward_or_callback_failure_discards_potentially_partial_cache(self):
        prompt, expected = "a" * 600 + "|", "abcdef"
        for origin in ("forward", "callback"):
            for error_type in (RuntimeError, InterruptedError):
                with self.subTest(origin=origin, error_type=error_type):
                    decoder, _ = self.make_decoder({prompt: expected})
                    original_cache = decoder.cache[0]

                    def failing_forward(chunk: list[int]) -> None:
                        original_cache.tokens.append(ord("?"))
                        raise error_type("Forward failed after partial KV update")

                    def failing_callback() -> bool:
                        if original_cache.tokens:
                            raise error_type("Callback failed")
                        return False

                    with self.assertRaises(error_type):
                        if origin == "forward":
                            with patch.object(decoder, "_prefill", side_effect=failing_forward):
                                decoder.generate(prompt)
                        else:
                            decoder.generate(prompt, cancelled=failing_callback)
                    self.assertTrue(original_cache.tokens)
                    self.assertIsNot(decoder.cache[0], original_cache)
                    self.assertEqual(decoder.cached_tokens, [])
                    self.assertEqual(decoder.cache[0].tokens, [])
                    self.assert_response(decoder.generate(prompt), prompt, expected)

    def test_shared_allocator_defers_global_clear_until_other_inference_has_finished(self):
        allocator = decoder_module.MLXAllocator(cache_limit_mb=17)
        with patch.object(decoder_module.mx, "get_cache_memory", return_value=18 * 1024**2), \
                patch.object(decoder_module.mx, "synchronize") as synchronize, \
                patch.object(decoder_module.mx, "clear_cache") as clear:
            with allocator.session():
                with allocator.session():
                    allocator.reclaim()
                    synchronize.assert_called_once_with()
                    clear.assert_not_called()
                allocator.reclaim()
                clear.assert_called_once_with()

    def test_simultaneously_finishing_sessions_reclaim_when_the_final_session_exits(self):
        allocator = decoder_module.MLXAllocator(cache_limit_mb=0)
        entered = threading.Barrier(2, timeout=2)
        reclaimed = threading.Barrier(2, timeout=2)
        free_bytes = 1024

        def clear_cache():
            nonlocal free_bytes
            free_bytes = 0

        def finish_request():
            with allocator.session():
                entered.wait()
                allocator.reclaim()
                # Neither session may exit before both have attempted reclamation.
                reclaimed.wait()

        with patch.object(decoder_module.mx, "get_cache_memory", side_effect=lambda: free_bytes), \
                patch.object(decoder_module.mx, "clear_cache", side_effect=clear_cache) as clear, \
                ThreadPoolExecutor(max_workers=2) as executor:
            requests = [executor.submit(finish_request) for _ in range(2)]
            for request in requests:
                request.result(timeout=3)
            clear.assert_called_once_with()
            self.assertEqual(free_bytes, 0)

    def test_final_session_cleanup_failure_preserves_its_own_generation_error(self):
        for error_type in (None, RuntimeError, decoder_module.GenerationCancelled):
            with self.subTest(error_type=error_type):
                allocator = decoder_module.MLXAllocator(cache_limit_mb=0)
                cleanup_error = OSError("final allocator clear failed")
                error_class = cast(type[BaseException] | None, error_type)
                original_error = error_class("generation failed") if error_class else None
                with patch.object(decoder_module.mx, "get_cache_memory", return_value=1), \
                        patch.object(decoder_module.mx, "clear_cache", side_effect=cleanup_error):
                    if original_error is None:
                        with self.assertRaises(OSError) as caught:
                            with allocator.session():
                                pass
                        self.assertIs(caught.exception, cleanup_error)
                    else:
                        with self.assertRaises(cast(type[BaseException], error_class)) as caught:
                            with allocator.session():
                                raise original_error
                        self.assertIs(caught.exception, original_error)
                        self.assertTrue(any(str(cleanup_error) in note
                                            for note in original_error.__notes__))
                with patch.object(decoder_module.mx, "get_cache_memory", return_value=1), \
                        patch.object(decoder_module.mx, "clear_cache") as clear:
                    with allocator.session():
                        pass
                    clear.assert_called_once_with()

    def test_failed_peer_session_does_not_block_later_allocator_cleanup(self):
        allocator = decoder_module.MLXAllocator(cache_limit_mb=0)
        with patch.object(decoder_module.mx, "get_cache_memory", return_value=1), \
                patch.object(decoder_module.mx, "clear_cache") as clear:
            with allocator.session():
                with self.assertRaisesRegex(RuntimeError, "peer failed"):
                    with allocator.session():
                        raise RuntimeError("peer failed")
                allocator.reclaim()
                clear.assert_called_once_with()
            clear.reset_mock()
            with allocator.session():
                allocator.reclaim()
                clear.assert_called_once_with()

    def test_shared_allocator_keeps_model_inference_locks_streams_and_kv_independent(self):
        with patch.object(decoder_module.mx, "set_cache_limit") as set_limit:
            allocator = decoder_module.MLXAllocator(cache_limit_mb=17)
            first, _ = self.make_decoder({"first|": "alpha"}, allocator=allocator)
            second, _ = self.make_decoder({"second|": "beta"}, allocator=allocator)
            set_limit.assert_called_once_with(17 * 1024**2)
        self.assertIsNot(first.cache[0], second.cache[0])
        self.assertIsNot(first.stream, second.stream)
        entered = threading.Barrier(2, timeout=2)
        first_prefill = first._prefill
        second_prefill = second._prefill

        def first_forward(chunk: list[int]) -> Any:
            entered.wait()
            return first_prefill(chunk)

        def second_forward(chunk: list[int]) -> Any:
            entered.wait()
            return second_prefill(chunk)

        with patch.object(first, "_prefill", side_effect=first_forward), \
                patch.object(second, "_prefill", side_effect=second_forward), \
                ThreadPoolExecutor(max_workers=2) as executor:
            first_result = executor.submit(first.generate, "first|")
            second_result = executor.submit(second.generate, "second|")
            self.assert_response(first_result.result(timeout=3), "first|", "alpha")
            self.assert_response(second_result.result(timeout=3), "second|", "beta")
        self.assertEqual(first.cache[0].tokens, list(map(ord, "first|alpha")))
        self.assertEqual(second.cache[0].tokens, list(map(ord, "second|beta")))
        second_cache = list(second.cached_tokens)
        self.assert_response(first.generate("first|"), "first|", "alpha")
        self.assertEqual(second.cached_tokens, second_cache)
        self.assertEqual(second.cache[0].tokens, second_cache)

    def test_allocator_limit_is_configured_before_model_loading(self):
        for options, expected_mb in (({}, 256), ({"cache_limit_mb": 0}, 0),
                                     ({"cache_limit_mb": 17}, 17)):
            with self.subTest(options=options):
                events: list[tuple[str, object]] = []

                def load_model(path: str) -> tuple[TargetModel, Tokenizer]:
                    events.append(("load", path))
                    return TargetModel({}), Tokenizer()

                def record_limit(size: int) -> None:
                    events.append(("limit", size))

                with patch.object(decoder_module.mx, "set_cache_limit",
                                  side_effect=record_limit), \
                        patch.object(decoder_module, "load", side_effect=load_model):
                    decoder_module.Decoder("fake-model", **options)
                self.assertEqual(events, [("limit", expected_mb * 1024**2),
                                          ("load", "fake-model")])

    def test_memory_snapshot_counts_all_live_kv_layers_separately_from_allocator(self):
        decoder, _ = self.make_decoder({"prompt|": "answer"})
        decoder.cache = [Cache(), Cache()]
        decoder.cache[0].tokens = [1, 2, 3]
        decoder.cache[1].tokens = [4, 5]
        with patch.object(decoder_module.mx, "get_active_memory", return_value=1000), \
                patch.object(decoder_module.mx, "get_cache_memory", return_value=2000), \
                patch.object(decoder_module.mx, "get_peak_memory", return_value=4000):
            self.assertEqual(decoder.memory_snapshot(), {
                "scope": "process", "active_bytes": 1000, "cache_bytes": 2000, "peak_bytes": 4000,
                "kv_cache_bytes": 40, "cache_limit_bytes": 256 * 1024**2})

    def test_invalid_allocator_limits_do_not_load_or_change_global_limit(self):
        for limit in (-1, 1.5, True, False, "256", None):
            with self.subTest(limit=limit), \
                    patch.object(decoder_module, "load") as load, \
                    patch.object(decoder_module.mx, "set_cache_limit") as set_limit:
                with self.assertRaises(ValueError):
                    decoder_module.Decoder("fake-model", cache_limit_mb=limit)
                load.assert_not_called()
                set_limit.assert_not_called()

    def test_request_reclaims_only_unused_memory_over_the_limit_and_keeps_kv(self):
        prompt, expected = "abcdef!|", "abcXef!"
        for mode in ("greedy", "source"):
            for cache_bytes in (0, 256 * 1024**2, 256 * 1024**2 + 1):
                with self.subTest(mode=mode, cache_bytes=cache_bytes):
                    decoder, _ = self.make_decoder({prompt: expected})
                    live_cache = decoder.cache[0]
                    events: list[str] = []
                    allocator = {"cache": cache_bytes}

                    def synchronize():
                        self.assertTrue(decoder.lock.locked())
                        events.append("sync")

                    def clear_cache():
                        self.assertTrue(decoder.lock.locked())
                        self.assertIn("sync", events)
                        events.append("clear")
                        allocator["cache"] = 0

                    with patch.object(decoder_module.mx, "synchronize", side_effect=synchronize), \
                            patch.object(decoder_module.mx, "clear_cache", side_effect=clear_cache), \
                            patch.object(decoder_module.mx, "get_cache_memory",
                                         side_effect=lambda: allocator["cache"]), \
                            patch.object(decoder_module.mx, "get_active_memory", return_value=4000), \
                            patch.object(decoder_module.mx, "get_peak_memory", return_value=9000):
                        result = decoder.generate(prompt, mode=mode)
                        self.assert_response(result, prompt, expected)
                        self.assertEqual(events.count("clear"), int(cache_bytes > 256 * 1024**2))
                        self.assertIs(decoder.cache[0], live_cache)
                        self.assertEqual(live_cache.tokens, list(map(ord, prompt + expected)))
                        self.assertEqual(result["memory"], {
                            "scope": "process", "active_bytes": 4000, "cache_bytes": allocator["cache"],
                            "peak_bytes": 9000, "kv_cache_bytes": live_cache.nbytes,
                            "cache_limit_bytes": 256 * 1024**2})
                        repeated = decoder.generate(prompt, mode=mode)
                        self.assert_response(repeated, prompt, expected)
                        self.assertNotIn("timings", repeated)
                        self.assertEqual(repeated["cache"]["cached_prompt_tokens"],
                                         len(prompt) - 1)
                        self.assertIs(decoder.cache[0], live_cache)
                        self.assertEqual(live_cache.tokens, decoder.cached_tokens)

    def test_zero_limit_reclaims_unused_cache_after_zero_token_request(self):
        model = TargetModel({"prompt|": "answer"})
        with patch.object(decoder_module, "load", return_value=(model, Tokenizer())):
            decoder = decoder_module.Decoder("fake-model", cache_limit_mb=0)
        free_bytes = 1

        def clear_unused_cache():
            nonlocal free_bytes
            free_bytes = 0

        with patch.object(decoder_module.mx, "get_cache_memory", side_effect=lambda: free_bytes), \
                patch.object(decoder_module.mx, "clear_cache", side_effect=clear_unused_cache) as clear_cache:
            self.assert_response(decoder.generate("prompt|", max_tokens=0), "prompt|", "", "length")
        clear_cache.assert_called_once_with()
        self.assertEqual(decoder.cache[0].tokens, list(map(ord, "prompt|")))

    def test_cleanup_runs_on_cancellation_and_failure_and_leaves_decoder_reusable(self):
        prompt, expected = "abcdef!|", "abcXef!"
        for phase in ("before_prefill", "after_first_token", "forward_error"):
            with self.subTest(phase=phase):
                decoder, _ = self.make_decoder({prompt: expected})
                live_cache = decoder.cache[0]
                events: list[str] = []
                free_bytes = 2**30

                def synchronize():
                    self.assertTrue(decoder.lock.locked())
                    events.append("sync")

                def clear_cache():
                    nonlocal free_bytes
                    free_bytes = 0
                    self.assertTrue(decoder.lock.locked())
                    self.assertIn("sync", events)
                    events.append("clear")

                def cancel():
                    raise decoder_module.GenerationCancelled("cancelled by caller")

                def fail_forward(chunk: list[int]) -> None:
                    live_cache.tokens.append(ord("?"))
                    raise RuntimeError("partial forward")

                with patch.object(decoder_module.mx, "get_cache_memory", side_effect=lambda: free_bytes), \
                        patch.object(decoder_module.mx, "synchronize", side_effect=synchronize), \
                        patch.object(decoder_module.mx, "clear_cache", side_effect=clear_cache):
                    if phase == "forward_error":
                        with patch.object(decoder, "_prefill", side_effect=fail_forward):
                            with self.assertRaisesRegex(RuntimeError, "partial forward"):
                                decoder.generate(prompt)
                        self.assertIsNot(decoder.cache[0], live_cache)
                        self.assertEqual(decoder.cached_tokens, [])
                    else:
                        options = ({"cancelled": lambda: True} if phase == "before_prefill"
                                   else {"on_first_token": cancel})
                        with self.assertRaises(decoder_module.GenerationCancelled):
                            decoder.generate(prompt, **options)
                        self.assertIs(decoder.cache[0], live_cache)
                        self.assertEqual(live_cache.tokens, decoder.cached_tokens)
                        expected_cache = [] if phase == "before_prefill" else list(map(ord, prompt + expected[:1]))
                        self.assertEqual(live_cache.tokens, expected_cache)
                    self.assertEqual(events.count("clear"), 1)
                self.assertFalse(decoder.lock.locked())
                self.assert_response(decoder.generate(prompt), prompt, expected)

    def test_failed_request_releases_temporary_buffers_before_reclaim_even_with_retained_error(self):
        for error_type in (decoder_module.GenerationCancelled, RuntimeError):
            with self.subTest(error_type=error_type):
                decoder, _ = self.make_decoder({"prompt|": "answer"})
                allocator: dict[str, int] = {"active": 0, "cache": 0}
                original_error = error_type("failed request")
                buffers: list[weakref.ReferenceType[Buffer]] = []

                class Buffer:
                    def __init__(self):
                        allocator["active"] += 2**30

                    def __del__(self):
                        allocator["active"] -= 2**30
                        allocator["cache"] += 2**30

                def fail_generation(*_args: object) -> None:
                    temporary = Buffer()
                    buffers.append(weakref.ref(temporary))
                    raise original_error

                def clear_cache():
                    self.assertEqual(allocator["active"], 0)
                    allocator["cache"] = 0

                gc_was_enabled = gc.isenabled()
                gc.disable()
                try:
                    with patch.object(decoder, "_generate", new=fail_generation), \
                            patch.object(decoder_module.mx, "get_cache_memory",
                                         side_effect=lambda: allocator["cache"]), \
                            patch.object(decoder_module.mx, "clear_cache", side_effect=clear_cache) as clear:
                        try:
                            decoder.generate("prompt|")
                        except error_type as caught:
                            self.assertIs(caught, original_error)
                            traceback_names: list[str] = []
                            trace = caught.__traceback__
                            while trace is not None:
                                traceback_names.append(trace.tb_frame.f_code.co_name)
                                trace = trace.tb_next
                            self.assertIn("fail_generation", traceback_names)
                        else:
                            self.fail("Generation did not propagate its failure")
                        self.assertIsNone(buffers[0]())
                        self.assertEqual(allocator, {"active": 0, "cache": 0})
                        clear.assert_called_once_with()
                        # The caller retains the exception and traceback across collection.
                        gc.collect()
                        self.assertEqual(allocator, {"active": 0, "cache": 0})
                        self.assertIsNotNone(original_error.__traceback__)
                finally:
                    if gc_was_enabled:
                        gc.enable()

    def test_chained_failure_releases_inner_buffers_before_reclaim_even_with_a_cycle(self):
        for chain in ("cause", "context"):
            for cyclic in (False, True):
                with self.subTest(chain=chain, cyclic=cyclic):
                    decoder, _ = self.make_decoder({"prompt|": "answer"})
                    allocator: dict[str, int] = {"active": 0, "cache": 0}
                    inner_error = ValueError("inner forward failed")
                    outer_error = RuntimeError("wrapped generation failure")
                    if cyclic:
                        inner_error.__cause__ = outer_error
                    buffers: list[weakref.ReferenceType[Buffer]] = []
                    released_before_reclaim: list[bool] = []

                    class Buffer:
                        def __init__(self):
                            allocator["active"] += 2**30

                        def __del__(self):
                            allocator["active"] -= 2**30
                            allocator["cache"] += 2**30

                    def allocate_and_fail():
                        temporary = Buffer()
                        buffers.append(weakref.ref(temporary))
                        raise inner_error

                    def fail_generation(*_args: object) -> None:
                        try:
                            allocate_and_fail()
                        except ValueError as caught:
                            if chain == "cause":
                                raise outer_error from caught
                            raise outer_error

                    def synchronize():
                        released_before_reclaim.append(buffers[0]() is None)

                    def clear_cache():
                        self.assertEqual(allocator["active"], 0)
                        allocator["cache"] = 0

                    gc_was_enabled = gc.isenabled()
                    gc.disable()
                    try:
                        with patch.object(decoder, "_generate", new=fail_generation), \
                                patch.object(decoder_module.mx, "synchronize", side_effect=synchronize), \
                                patch.object(decoder_module.mx, "get_cache_memory",
                                             side_effect=lambda: allocator["cache"]), \
                                patch.object(decoder_module.mx, "clear_cache", side_effect=clear_cache) as clear:
                            try:
                                decoder.generate("prompt|")
                            except RuntimeError as caught:
                                self.assertIs(caught, outer_error)
                            else:
                                self.fail("Generation did not propagate its wrapped failure")
                            self.assertIs(outer_error.__context__, inner_error)
                            if chain == "cause":
                                self.assertIs(outer_error.__cause__, inner_error)
                            self.assertEqual(released_before_reclaim, [True])
                            self.assertIsNone(buffers[0]())
                            self.assertEqual(allocator, {"active": 0, "cache": 0})
                            clear.assert_called_once_with()
                            self.assertIsNotNone(inner_error.__traceback__)
                            self.assertIsNotNone(outer_error.__traceback__)
                    finally:
                        if gc_was_enabled:
                            gc.enable()

    def test_failed_request_does_not_retain_decoder_in_an_exception_cycle(self):
        def fail_generation(*_args: object) -> None:
            raise RuntimeError("forward failed")

        def run_failed_request():
            decoder, _ = self.make_decoder({"prompt|": "answer"})
            reference = weakref.ref(decoder)
            with patch.object(decoder, "_generate", new=fail_generation):
                try:
                    decoder.generate("prompt|")
                except RuntimeError:
                    pass
                else:
                    self.fail("Generation did not propagate its failure")
            return reference

        gc_was_enabled = gc.isenabled()
        gc.disable()
        try:
            reference = run_failed_request()
            self.assertIsNone(reference(), "Request traceback retained the decoder until cyclic GC")
        finally:
            if gc_was_enabled:
                gc.enable()

    def test_cleanup_failure_preserves_pending_exception_or_fails_successful_request(self):
        for error_type in (decoder_module.GenerationCancelled, RuntimeError, None):
            with self.subTest(error_type=error_type):
                decoder, _ = self.make_decoder({"prompt|": "answer"})
                cleanup_error = RuntimeError("allocator synchronization failed")
                error_class = cast(type[BaseException] | None, error_type)
                original_error = error_class("generation failed") if error_class else None
                with patch.object(decoder_module.mx, "synchronize", side_effect=cleanup_error):
                    if original_error is None:
                        with self.assertRaises(RuntimeError) as caught:
                            decoder.generate("prompt|")
                        self.assertIs(caught.exception, cleanup_error)
                    else:
                        with patch.object(decoder, "_generate", side_effect=original_error):
                            with self.assertRaises(cast(type[BaseException], error_class)) as caught:
                                decoder.generate("prompt|")
                        self.assertIs(caught.exception, original_error)
                        self.assertTrue(any("Allocator cleanup failed" in note
                                            and str(cleanup_error) in note
                                            for note in original_error.__notes__))
                self.assertFalse(decoder.lock.locked())

    def test_cleanup_failure_does_not_attach_to_callers_handled_exception(self):
        decoder, _ = self.make_decoder({"prompt|": "answer"})
        caller_error = ValueError("caller is handling an unrelated error")
        cleanup_error = RuntimeError("allocator synchronization failed")

        try:
            raise caller_error
        except ValueError:
            with patch.object(decoder_module.mx, "synchronize", side_effect=cleanup_error):
                with self.assertRaises(RuntimeError) as caught:
                    decoder.generate("prompt|")
            self.assertIs(caught.exception, cleanup_error)
            self.assertEqual(getattr(caller_error, "__notes__", []), [])

        self.assertFalse(decoder.lock.locked())

    def test_invalid_options_fail_before_inference(self):
        decoder, model = self.make_decoder({"ok|": "ok"})
        for options in ({"mode": "approximate"}, {"max_tokens": -1},
                        {"max_tokens": 32769}, {"max_tokens": 1.5},
                        {"draft_size": 0}, {"draft_size": 129},
                        {"stop": [""]}, {"stop": [None]}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                decoder.generate("ok|", **options)
        self.assertEqual(model.calls, [])

    def test_context_limit_accepts_exact_fit_without_truncating_output(self):
        prompt, expected = "abcdef!|", "abcdef!"
        decoder, _ = self.make_decoder({prompt: expected}, model_context=len(prompt) + len(expected))
        self.assert_response(decoder.generate(prompt, max_tokens=len(expected)),
                             prompt, expected, "length")

    def test_context_overflow_is_rejected_before_any_prefill(self):
        prompt = "abcdef!|"
        for model_limit, limit_override, budget in ((15, None, 8), (15, 12, 5), (7, None, 0)):
            with self.subTest(model_limit=model_limit, override=limit_override, budget=budget):
                decoder, model = self.make_decoder({prompt: "abcdef!"}, model_limit, limit_override)
                with patch.object(decoder, "_prefill", side_effect=AssertionError("Inference started")) as prefill:
                    with self.assertRaises(ValueError):
                        decoder.generate(prompt, max_tokens=budget)
                    prefill.assert_not_called()
                self.assertEqual(model.calls, [])

    def test_missing_model_context_uses_32768_token_limit(self):
        prompt = "a" * 32768 + "|"
        decoder, model = self.make_decoder({prompt: ""})
        with patch.object(decoder, "_prefill", side_effect=AssertionError("Inference started")) as prefill:
            with self.assertRaises(ValueError):
                decoder.generate(prompt, max_tokens=0)
            prefill.assert_not_called()
        self.assertEqual(model.calls, [])

    def test_explicit_context_override_cannot_raise_model_limit(self):
        for limit in (0, -1, 16, 1.5, True):
            with self.subTest(limit=limit), self.assertRaises(ValueError):
                self.make_decoder({"ok|": "ok"}, model_context=15, context_length=limit)


class DecoderCliTests(unittest.TestCase):
    def test_cache_limit_defaults_and_overrides_reach_decoder(self):
        for options, limit in (([], 256), (["--cache-limit-mb", "0"], 0),
                               (["--cache-limit-mb", "17"], 17)):
            with self.subTest(options=options), \
                    patch.object(sys, "argv", ["decoder.py", "--model", "fake-model",
                                               "--corpus", "cases.json", "--output", "unused.json", *options]), \
                    patch.object(decoder_module, "Decoder") as decoder, \
                    patch("builtins.open", mock_open(read_data='{"cases": []}')), \
                    patch("sys.stdout", new_callable=io.StringIO):
                decoder_module.main()
                decoder.assert_called_once_with("fake-model", context_length=None, cache_limit_mb=limit)

    def test_invalid_cli_limit_is_rejected_before_loading(self):
        for value in ("-1", "1.5", "bad"):
            with self.subTest(value=value), \
                    patch.object(sys, "argv", ["decoder.py", "--model", "fake-model",
                                               "--corpus", "cases.json", "--output", "unused.json",
                                               "--cache-limit-mb", value]), \
                    patch.object(decoder_module, "Decoder") as decoder, \
                    patch("sys.stderr", new_callable=io.StringIO):
                with self.assertRaises(SystemExit) as error:
                    decoder_module.main()
                self.assertEqual(error.exception.code, 2)
                decoder.assert_not_called()


if __name__ == "__main__":
    unittest.main()
