"""CPU-only contract tests for raw Qwen FIM continuation decoding."""

import importlib.util
from pathlib import Path
import sys
import types
import unittest
import weakref
from unittest.mock import patch

from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter


class Scalar(int):
    def item(self):
        return int(self)

    def reshape(self, *shape):
        if shape == (1, 1):
            return Array([Array([self])])
        if shape in ((1,), (-1,)):
            return Array([self])
        raise AssertionError(f"Unexpected scalar shape: {shape!r}")


class Array(list):
    """Only the array operations exercised by the CPU contract harness."""

    def __getitem__(self, key):
        value = super().__getitem__(key)
        return Array(value) if isinstance(key, slice) else value


class Cache:
    def __init__(self):
        self.tokens = []

    @property
    def nbytes(self):
        return len(self.tokens) * 8

    def is_trimmable(self):
        return True


class Scores:
    def __init__(self, token):
        self.token = token


class Logits:
    def __init__(self, token):
        self.token = token

    def __getitem__(self, index):
        if index == (slice(None), -1, slice(None)):
            return Scores(self.token)
        raise AssertionError(f"Unexpected logits index: {index!r}")


class Tokenizer:
    eos_token_ids = [0]
    eos_token_id = 0

    def __init__(self):
        self.encodes = []

    def encode(self, text, add_special_tokens=True):
        self.encodes.append((text, add_special_tokens))
        return list(map(ord, text))

    def decode(self, tokens):
        return "".join(map(chr, tokens))


class CausalOracle:
    """Small causal model whose expected answers are supplied by each test."""

    model_type = "fake"

    def __init__(self, tokenizer, responses, context_length=256):
        self.tokenizer = tokenizer
        self.responses = {tuple(map(ord, prompt)): text for prompt, text in responses.items()}
        self.args = types.SimpleNamespace(max_position_embeddings=context_length)
        self.calls = []
        self.fail_next = False

    def __call__(self, inputs, cache):
        (tokens,) = inputs
        tokens = list(tokens)
        for token in tokens:
            if hasattr(token, "on_forward"):
                token.on_forward()
        self.calls.append(tokens)
        if self.fail_next:
            self.fail_next = False
            raise RuntimeError("synthetic model failure")
        cache[0].tokens.extend(tokens)
        history = cache[0].tokens
        matching = [prompt for prompt in self.responses if history[:len(prompt)] == list(prompt)]
        if not matching:
            return Logits(ord("?"))
        prompt = max(matching, key=len)
        emitted = history[len(prompt):]
        answer = self.responses[prompt]
        if not answer.startswith(self.tokenizer.decode(emitted)):
            return Logits(ord("?"))
        if len(emitted) == len(answer):
            return Logits(0)
        return Logits(ord(answer[len(emitted)]))


class Runtime:
    def __init__(self, responses, context_length=256):
        self.tokenizer = Tokenizer()
        self.model = CausalOracle(self.tokenizer, responses, context_length)
        self.caches = []
        self.sampler_temperatures = []
        self.processor_options = []
        self.processor_histories = []
        self.processed_scores = []
        self.streams = []
        self.trims = []

        def make_cache(model):
            cache = [Cache()]
            self.caches.append(weakref.ref(cache[0]))
            return cache

        def trim_cache(caches, count):
            self.trims.append(count)
            for cache in caches:
                if count < 0 or count > len(cache.tokens):
                    raise AssertionError(f"Invalid cache trim: {count}")
                if count:
                    del cache.tokens[-count:]

        def make_sampler(temperature):
            self.sampler_temperatures.append(temperature)
            def sample(scores):
                if isinstance(scores.token, dict):
                    return Scalar(max(scores.token, key=scores.token.get))
                return Scalar(scores.token)
            return sample

        def make_processors(**options):
            self.processor_options.append(options)

            def track_history(history, scores):
                self.processor_histories.append(list(history))
                if isinstance(scores.token, dict):
                    values = dict(scores.token)
                    # The pinned mlx-lm processor applies the sign-aware penalty
                    # once per repeated ID in its fixed trailing context.
                    for token in set(history[-options.get("repetition_context_size", 20):]):
                        if token in values:
                            value = values[token]
                            values[token] = value * 1.1 if value < 0 else value / 1.1
                    self.processed_scores.append(values)
                    return Scores(values)
                return scores

            return [track_history]

        def stream(stream):
            self.streams.append(stream)
            return _NullContext()

        core = types.ModuleType("mlx.core")
        core.array = Array
        core.reshape = lambda value, shape: value.reshape(*shape)
        core.concatenate = lambda values: Array(
            token for value in values
            for token in (value if isinstance(value, list) else [value]))
        core.eval = lambda *values: None
        core.async_eval = lambda *values: None
        core.set_cache_limit = lambda value: None
        core.synchronize = lambda *streams: None
        core.get_cache_memory = lambda: 0
        core.get_active_memory = lambda: 0
        core.get_peak_memory = lambda: 0
        core.clear_cache = lambda: None
        core.gpu = object()
        core.new_thread_local_stream = lambda device: object()
        core.stream = stream

        mlx = types.ModuleType("mlx")
        mlx.core = core
        lm = types.ModuleType("mlx_lm")
        lm.load = lambda path: (self.model, self.tokenizer)
        cache_module = types.ModuleType("mlx_lm.models.cache")
        cache_module.make_prompt_cache = make_cache
        cache_module.trim_prompt_cache = trim_cache
        sample_utils = types.ModuleType("mlx_lm.sample_utils")
        sample_utils.make_sampler = make_sampler
        sample_utils.make_logits_processors = make_processors
        self.modules = {
            "mlx": mlx,
            "mlx.core": core,
            "mlx_lm": lm,
            "mlx_lm.models": types.ModuleType("mlx_lm.models"),
            "mlx_lm.models.cache": cache_module,
            "mlx_lm.sample_utils": sample_utils,
        }


class _NullContext:
    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class QueuedRuntime(Runtime):
    """Model async submission separately from completion, without a GPU."""

    def __init__(self, responses):
        super().__init__(responses)
        self.pending = []
        self.submissions = 0
        self.max_pending = 0
        self.decode_pending = []
        self.forward_before_item = []
        self.fail_submission = None
        self.evaluation_error = RuntimeError("queued evaluation failed")
        runtime = self

        class QueuedScalar(Scalar):
            def on_forward(self):
                if getattr(self, "evaluated", False) or getattr(self, "materialized", False):
                    raise AssertionError("next graph constructed after current token evaluation")
                self.forward_submission = runtime.submissions

            def item(self):
                if hasattr(self, "forward_submission"):
                    runtime.forward_before_item.append(
                        runtime.submissions > self.forward_submission)
                runtime.complete(self)
                self.materialized = True
                return super().item()

        sample_utils = self.modules["mlx_lm.sample_utils"]
        make_sampler = sample_utils.make_sampler

        def queued_sampler(temperature):
            sample = make_sampler(temperature)
            return lambda scores: QueuedScalar(sample(scores))

        def submit(*values):
            for value in values:
                self.submissions += 1
                value.submission = self.submissions
                self.pending.append(value)
                self.max_pending = max(self.max_pending, len(self.pending))

        def evaluate(*values):
            for value in values:
                self.complete(value)

        def synchronize(*_):
            for value in list(self.pending):
                self.complete(value)

        decode = self.tokenizer.decode

        def observe_decode(tokens):
            self.decode_pending.append(len(self.pending))
            return decode(tokens)

        sample_utils.make_sampler = queued_sampler
        cache_module = self.modules["mlx_lm.models.cache"]
        trim_cache = cache_module.trim_prompt_cache
        make_cache = cache_module.make_prompt_cache

        def checked_trim(caches, count):
            if self.pending:
                raise AssertionError("KV cache trimmed before queued work completed")
            return trim_cache(caches, count)

        def checked_make_cache(model):
            if self.pending:
                raise AssertionError("KV cache replaced before queued work completed")
            return make_cache(model)

        cache_module.trim_prompt_cache = checked_trim
        cache_module.make_prompt_cache = checked_make_cache
        core = self.modules["mlx.core"]
        core.async_eval = submit
        core.eval = evaluate
        core.synchronize = synchronize
        self.tokenizer.decode = observe_decode

    def complete(self, value):
        for index, pending in enumerate(self.pending):
            if pending is value:
                del self.pending[index]
                pending.evaluated = True
                if pending.submission == self.fail_submission:
                    raise self.evaluation_error
                break


def load_continuation_decoder(runtime):
    server_dir = Path(__file__).resolve().parents[1] / "src"
    decoder_path = server_dir / "decoder.py"
    continuation_path = server_dir / "continuation_decoder.py"
    decoder_spec = importlib.util.spec_from_file_location("decoder", decoder_path)
    continuation_spec = importlib.util.spec_from_file_location(
        "continuation_decoder_contract", continuation_path)
    decoder = importlib.util.module_from_spec(decoder_spec)
    continuation = importlib.util.module_from_spec(continuation_spec)
    with patch.object(sys, "path", [str(server_dir), *sys.path]), \
            patch.dict(sys.modules, runtime.modules), patch.dict(sys.modules, {"decoder": decoder}):
        decoder_spec.loader.exec_module(decoder)
        continuation_spec.loader.exec_module(continuation)
    return continuation


def make_decoder(runtime, context_length=None):
    module = load_continuation_decoder(runtime)
    decoder = module.ContinuationDecoder("fake-model", context_length=context_length)
    return module, decoder


class ContinuationDecoderTests(unittest.TestCase):
    def assert_cache_coherent(self, decoder):
        self.assertEqual(decoder.cache[0].tokens, decoder.cached_tokens)

    def test_async_work_overlaps_cpu_decode_and_drains_before_cleanup_and_unlock(self):
        prompt = "<|fim_prefix|>x<|fim_suffix|>y<|fim_middle|>"
        runtime = QueuedRuntime({prompt: "abcd"})
        _, decoder = make_decoder(runtime)
        observations = []
        uncommitted = []
        reclaim = decoder.allocator.reclaim
        prefill_token = decoder._prefill_token
        lock = decoder.lock
        test = self

        class CheckedLock:
            def __enter__(self):
                return lock.__enter__()

            def __exit__(self, *args):
                test.assertEqual(runtime.pending, [])
                test.assert_cache_coherent(decoder)
                observations.append("unlock")
                return lock.__exit__(*args)

        def checked_reclaim():
            self.assertEqual(runtime.pending, [])
            self.assert_cache_coherent(decoder)
            observations.append("reclaim")
            reclaim()

        def checked_forward(sampled):
            logits = prefill_token(sampled)
            uncommitted.append(len(decoder.cache[0].tokens) - len(decoder.cached_tokens))
            self.assertLessEqual(uncommitted[-1], 2)
            return logits

        with patch.object(decoder, "lock", CheckedLock()), \
                patch.object(decoder, "_prefill_token", side_effect=checked_forward), \
                patch.object(decoder.allocator, "reclaim", side_effect=checked_reclaim):
            result = decoder.generate(prompt, max_tokens=4)
            warm = decoder.generate(prompt, max_tokens=4)

        self.assertEqual(result["tokens"], list(map(ord, "abcd")))
        self.assertEqual(warm["tokens"], result["tokens"])
        self.assertEqual(warm["cache"]["cached_prompt_tokens"], len(prompt) - 1)
        self.assertTrue(any(runtime.decode_pending), "no GPU work overlapped CPU decoding")
        self.assertEqual(runtime.max_pending, 2)
        self.assertEqual(max(uncommitted), 2)
        self.assertEqual(runtime.forward_before_item, [True] * 6)
        self.assertGreater(runtime.submissions, 0)
        self.assertEqual(observations, ["reclaim", "unlock"] * 2)

    def test_async_terminal_paths_keep_exact_outputs_and_forward_boundaries(self):
        prompt = "<|fim_prefix|>x<|fim_suffix|>y<|fim_middle|>"
        for outcome, answer, limit, stop, expected, forward_count in (
                ("zero", "abc", 0, None, "", 1),
                ("one", "abc", 1, None, "a", 1),
                ("length", "abcdef", 3, None, "abc", 3),
                ("eos", "ab", 5, None, "ab", 4),
                ("immediate_eos", "", 5, None, "", 2),
                ("stop", "aENDtail", 12, "END", "a", 5)):
            with self.subTest(outcome=outcome):
                runtime = QueuedRuntime({prompt: answer})
                _, decoder = make_decoder(runtime)
                result = decoder.generate(prompt, max_tokens=limit, stop=stop)
                self.assertEqual(result["text"], expected)
                self.assertEqual(result["finish_reason"],
                                 "length" if outcome in ("zero", "one", "length") else "stop")
                emitted = "aEND" if outcome == "stop" else expected
                self.assertEqual(result["tokens"], list(map(ord, emitted)))
                self.assertEqual(result["usage"]["completion_tokens"], len(emitted))
                self.assertEqual(len(runtime.model.calls), forward_count)
                self.assertEqual(runtime.pending, [])
                self.assert_cache_coherent(decoder)
                # Stop/length retain only the inputs needed for accepted tokens;
                # EOS detection also evaluates the final emitted token.
                retained = emitted if outcome == "eos" else emitted[:-1]
                self.assertEqual(decoder.cached_tokens,
                                 list(map(ord, prompt + retained)))
                recovered = decoder.generate(prompt, max_tokens=12)
                self.assertEqual(recovered["text"], answer)
                self.assertEqual(runtime.pending, [])
                self.assert_cache_coherent(decoder)

    def test_async_cancellation_and_callback_errors_drain_and_recover(self):
        prompt = "<|fim_prefix|>x<|fim_suffix|>y<|fim_middle|>"
        for outcome in ("cancel_before_prefill", "cancel_queued", "callback",
                        "evaluation", "evaluation_second", "stop_drain", "cancel_drain_failure"):
            with self.subTest(outcome=outcome):
                runtime = QueuedRuntime({prompt: "abcd"})
                module, decoder = make_decoder(runtime)
                callback_error = RuntimeError("first token callback failed")
                callback_pending = []
                reclaim = decoder.allocator.reclaim

                def callback():
                    callback_pending.append(len(runtime.pending))
                    if outcome == "callback":
                        raise callback_error
                    if outcome == "cancel_drain_failure":
                        raise module.GenerationCancelled("cancelled by callback")

                def cancelled():
                    return (outcome == "cancel_before_prefill"
                            or (outcome == "cancel_queued" and runtime.submissions >= 2))

                def checked_reclaim():
                    self.assertEqual(runtime.pending, [])
                    self.assert_cache_coherent(decoder)
                    reclaim()

                if outcome in ("evaluation", "evaluation_second", "stop_drain",
                               "cancel_drain_failure"):
                    runtime.fail_submission = 1 if outcome == "evaluation" else 2
                expected_error = (module.GenerationCancelled if outcome in (
                    "cancel_before_prefill", "cancel_queued")
                                  else RuntimeError)
                with patch.object(decoder.allocator, "reclaim", side_effect=checked_reclaim):
                    with self.assertRaises(expected_error) as caught:
                        decoder.generate(prompt, max_tokens=8, cancelled=cancelled,
                                         on_first_token=callback,
                                         stop="a" if outcome == "stop_drain" else None)
                if outcome == "callback":
                    self.assertIs(caught.exception, callback_error)
                    self.assertEqual(callback_pending, [1])
                elif outcome in ("evaluation", "evaluation_second", "stop_drain",
                                 "cancel_drain_failure"):
                    self.assertIs(caught.exception, runtime.evaluation_error)
                if outcome == "evaluation_second":
                    # The first output was delivered; the next iteration built
                    # another forward while its preceding input was uncommitted.
                    self.assertEqual(len(runtime.model.calls), 3)
                    self.assertEqual(runtime.max_pending, 2)
                    self.assertEqual(callback_pending, [1])
                if outcome in ("callback", "evaluation", "evaluation_second",
                               "stop_drain", "cancel_drain_failure"):
                    self.assertEqual(decoder.cached_tokens, [])
                self.assertEqual(runtime.pending, [])
                self.assert_cache_coherent(decoder)
                runtime.fail_submission = None
                recovered = decoder.generate(prompt, max_tokens=8)
                self.assertEqual(recovered["text"], "abcd")
                self.assertEqual(runtime.pending, [])
                self.assert_cache_coherent(decoder)

    def test_reuses_only_exact_prefix_and_matches_fresh_outputs_after_edits(self):
        def fim(prefix, suffix):
            return f"<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>"

        prompts = [
            fim("def answer():\n    ret", "\n"),
            fim("def answer():\n    ret", "\n"),
            fim("def answer():\n    retu", "\n"),
            fim("def answer():\n    retu", "\n# changed suffix"),
            fim("class Other:\n    pass", "\n"),
            fim("def answer():\n    ret", "\n"),
        ]
        responses = {prompt: f"answer{index}" for index, prompt in enumerate(prompts)}
        expected_common = [
            0,
            len(prompts[0]) - 1,
            len("<|fim_prefix|>def answer():\n    ret"),
            len("<|fim_prefix|>def answer():\n    retu<|fim_suffix|>\n"),
            len("<|fim_prefix|>"),
            len("<|fim_prefix|>"),
        ]
        runtime = Runtime(responses)
        _, decoder = make_decoder(runtime)
        cache = decoder.cache[0]
        for prompt, common in zip(prompts, expected_common):
            with self.subTest(prompt=prompt):
                prior_tokens = list(decoder.cached_tokens)
                prompt_tokens = list(map(ord, prompt))
                calls_before = len(runtime.model.calls)
                trims_before = len(runtime.trims)
                result = decoder.generate(prompt, max_tokens=16)
                fresh_runtime = Runtime(responses)
                _, fresh = make_decoder(fresh_runtime)
                expected = fresh.generate(prompt, max_tokens=16)

                for key in ("text", "tokens", "finish_reason", "usage"):
                    self.assertEqual(result[key], expected[key])
                self.assertEqual(result["cache"], {"cached_prompt_tokens": common})
                self.assertEqual(runtime.model.calls[calls_before], prompt_tokens[common:])
                self.assertTrue(runtime.model.calls[calls_before])
                self.assertEqual(runtime.trims[trims_before:],
                                 [len(prior_tokens) - common, 1])
                self.assertIs(decoder.cache[0], cache)
                self.assert_cache_coherent(decoder)
        self.assertEqual(len(runtime.caches), 1)

    def test_token_prefix_reuse_leaves_final_prompt_token_for_logits(self):
        prompt = "<|fim_prefix|>x<|fim_suffix|>y<|fim_middle|>"
        runtime = Runtime({prompt: ""})
        _, decoder = make_decoder(runtime)
        decoder.generate(prompt)
        calls_before = len(runtime.model.calls)
        result = decoder.generate(prompt)
        self.assertEqual(result["cache"]["cached_prompt_tokens"], len(prompt) - 1)
        self.assertEqual(runtime.model.calls[calls_before:], [[ord(prompt[-1])], [0]])
        self.assert_cache_coherent(decoder)

    def test_reuse_follows_encoded_tokens_including_shorter_and_fully_divergent_prompts(self):
        prompts = [f"<|fim_prefix|>{label}<|fim_suffix|>y<|fim_middle|>"
                   for label in ("original", "shorter", "divergent", "single")]
        encoded = dict(zip(prompts, ([11, 12, 13, 14], [11, 12], [21, 22], [21])))
        runtime = Runtime({})
        runtime.tokenizer.encode = lambda text, add_special_tokens=False: list(encoded[text])
        _, decoder = make_decoder(runtime)
        for prompt, common in zip(prompts, (0, 1, 0, 0)):
            with self.subTest(prompt=prompt):
                result = decoder.generate(prompt, max_tokens=0)
                self.assertEqual(result["cache"]["cached_prompt_tokens"], common)
                self.assertEqual(runtime.model.calls[-1], encoded[prompt][common:])
                self.assertEqual(decoder.cached_tokens, encoded[prompt])
                self.assert_cache_coherent(decoder)

    def test_cancelled_warm_prefill_retains_only_synchronized_exact_prefix(self):
        old = "<|fim_prefix|>old<|fim_suffix|>y<|fim_middle|>"
        new = "<|fim_prefix|>other<|fim_suffix|>y<|fim_middle|>"
        runtime = Runtime({old: "abc", new: "right"})
        module, decoder = make_decoder(runtime)
        decoder.generate(old)
        calls_before = len(runtime.model.calls)
        with self.assertRaises(module.GenerationCancelled):
            decoder.generate(new, cancelled=lambda: True)
        # The shared character 'o' is valid; the rest of the old prompt and its
        # completion must be trimmed before a cancellation can retain the cache.
        self.assertEqual(decoder.cached_tokens, list(map(ord, "<|fim_prefix|>o")))
        self.assertEqual(len(runtime.model.calls), calls_before)
        self.assert_cache_coherent(decoder)
        result = decoder.generate(new)
        self.assertEqual(result["text"], "right")
        self.assertEqual(result["cache"]["cached_prompt_tokens"], len("<|fim_prefix|>o"))

    def test_callback_failure_invalidates_evaluated_cache_and_next_request_recovers(self):
        prompt = "<|fim_prefix|>x<|fim_suffix|>y<|fim_middle|>"
        runtime = Runtime({prompt: "right"})
        _, decoder = make_decoder(runtime)
        decoder.generate(prompt)
        previous_cache = runtime.caches[-1]
        failure = RuntimeError("first token callback failed")

        def fail_callback():
            raise failure

        with self.assertRaises(RuntimeError) as caught:
            decoder.generate(prompt, on_first_token=fail_callback)
        self.assertIs(caught.exception, failure)
        self.assertIsNone(previous_cache())
        self.assertEqual(decoder.cached_tokens, [])
        self.assert_cache_coherent(decoder)
        result = decoder.generate(prompt)
        self.assertEqual(result["text"], "right")
        self.assertEqual(result["cache"]["cached_prompt_tokens"], 0)

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
            prompt = "<|fim_prefix|>x<|fim_suffix|>y<|fim_middle|>"
            runtime = Runtime({prompt: "answer"})
            _, decoder = make_decoder(runtime)
            result = decoder.generate(prompt)

            self.assertEqual(result["cache"], {"cached_prompt_tokens": 0})
            self.assertNotIn("timings", result)
            spans = exporter.get_finished_spans()
            self.assertEqual({span.name for span in spans}, {
                "decoder.prefill", "decoder.decode"})
            self.assertTrue(all(span.attributes["nesweep.outcome"] == "success"
                                for span in spans))
        finally:
            observability.shutdown_tracing()

    def test_generates_from_exact_raw_fim_prompt_with_greedy_penalty_and_usage(self):
        prompt = "<|fim_prefix|>def answer():\n    <|fim_suffix|>return 42\n<|fim_middle|>"
        runtime = Runtime({prompt: "return 42\n"})
        _, decoder = make_decoder(runtime)

        result = decoder.generate(prompt, max_tokens=20)

        self.assertEqual(runtime.tokenizer.encodes, [(prompt, False)])
        self.assertEqual(result["text"], "return 42\n")
        self.assertEqual(result["finish_reason"], "stop")
        self.assertEqual(result["tokens"], list(map(ord, "return 42\n")))
        self.assertEqual(result["usage"], {
            "prompt_tokens": len(prompt), "completion_tokens": len("return 42\n"),
            "total_tokens": len(prompt) + len("return 42\n")})
        self.assertEqual(runtime.sampler_temperatures, [0])
        self.assertEqual(runtime.processor_options, [{
            "repetition_penalty": 1.1, "repetition_context_size": 20}])
        self.assertEqual(runtime.processor_histories[0], list(map(ord, prompt[-20:])))
        self.assertEqual(runtime.processor_histories[-2], list(map(ord, (prompt + "return 42\n")[-20:])))
        self.assertEqual(runtime.processor_histories[-1],
                         [*map(ord, (prompt + "return 42\n")[-19:]), 0])

    def test_bounded_repetition_history_matches_full_history_greedy_reference(self):
        prompt = "<|fim_prefix|>x<|fim_suffix|>y<|fim_middle|>"
        # Token lengths are independent of raw FIM text length. In particular,
        # special marker tokens allow a valid FIM prompt shorter than 20 IDs.
        for prompt_size in (3, 20, 21, 1000):
            with self.subTest(prompt_size=prompt_size):
                prompt_ids = [ord("c")] * (prompt_size - 2) + [ord("a"), ord("a")]
                runtime = Runtime({}, context_length=2048)
                runtime.tokenizer.encode = lambda text, add_special_tokens=False: list(prompt_ids)
                raw_scores = {ord("a"): 11.0, ord("b"): 10.5,
                              ord("c"): -1.0, ord("d"): -1.05}

                class FixedLogitsModel:
                    args = types.SimpleNamespace(max_position_embeddings=2048)

                    def __call__(self, inputs, cache):
                        cache[0].tokens.extend(inputs[0])
                        return Logits(dict(raw_scores))

                runtime.model = FixedLogitsModel()
                _, decoder = make_decoder(runtime)
                expected_tokens, expected_scores, expected_histories = [], [], []
                # Reference behavior deliberately keeps the full original
                # history, as the unoptimized caller of mlx-lm did.
                for _ in range(24):
                    history = prompt_ids + expected_tokens
                    values = dict(raw_scores)
                    for token in set(history[-20:]):
                        if token in values:
                            value = values[token]
                            values[token] = value / 1.1 if value >= 0 else value * 1.1
                    expected_histories.append(history[-20:])
                    expected_scores.append(values)
                    expected_tokens.append(max(values, key=values.get))

                result = decoder.generate(prompt, max_tokens=24)

                self.assertEqual(result["tokens"], expected_tokens)
                self.assertEqual(result["text"].encode("utf-8"), bytes(expected_tokens))
                self.assertEqual(result["finish_reason"], "length")
                self.assertEqual(result["usage"], {
                    "prompt_tokens": prompt_size, "completion_tokens": 24,
                    "total_tokens": prompt_size + 24})
                self.assertEqual(runtime.processor_histories, expected_histories)
                self.assertEqual(runtime.processed_scores, expected_scores)
                self.assertTrue(all(len(history) <= 20 for history in runtime.processor_histories))
                self.assertEqual(expected_tokens[:2], [ord("b"), ord("a")])
                self.assertEqual(expected_scores[0][ord("a")], 10.0)
                self.assertEqual(expected_scores[0][ord("c")], -1.1)

                # A warm request must still seed penalties from the entire new
                # prompt, including tokens omitted from the suffix prefill.
                runtime.processor_histories.clear()
                runtime.processed_scores.clear()
                warm = decoder.generate(prompt, max_tokens=24)
                self.assertEqual(warm["tokens"], expected_tokens)
                self.assertEqual(warm["cache"]["cached_prompt_tokens"], prompt_size - 1)
                self.assertEqual(runtime.processor_histories, expected_histories)
                self.assertEqual(runtime.processed_scores, expected_scores)

    def test_first_matching_stop_string_ends_output(self):
        prompt = "<|fim_prefix|>x<|fim_suffix|>y<|fim_middle|>"
        runtime = Runtime({prompt: "abcENDtailSTOP"})
        _, decoder = make_decoder(runtime)

        result = decoder.generate(prompt, max_tokens=32, stop=["STOP", "END"])

        self.assertEqual(result["text"], "abc")
        self.assertEqual(result["finish_reason"], "stop")
        self.assertEqual(result["usage"]["completion_tokens"], len("abcEND"))

    def test_max_token_limit_is_reported_as_length(self):
        prompt = "<|fim_prefix|>x<|fim_suffix|>y<|fim_middle|>"
        runtime = Runtime({prompt: "abcdefgh"})
        _, decoder = make_decoder(runtime)

        result = decoder.generate(prompt, max_tokens=3)

        self.assertEqual(result["text"], "abc")
        self.assertEqual(result["finish_reason"], "length")
        self.assertEqual(result["usage"]["completion_tokens"], 3)

    def test_zero_token_cap_and_context_limit(self):
        prompt = "<|fim_prefix|>x<|fim_suffix|>y<|fim_middle|>"
        runtime = Runtime({prompt: "abc"}, context_length=len(prompt) + 2)
        _, decoder = make_decoder(runtime)

        empty = decoder.generate(prompt, max_tokens=0)
        self.assertEqual(empty["text"], "")
        self.assertEqual(empty["finish_reason"], "length")
        self.assertEqual(empty["usage"]["completion_tokens"], 0)
        with self.assertRaisesRegex(ValueError, "context_length"):
            decoder.generate(prompt, max_tokens=3)

    def test_malformed_fim_and_excessive_token_limits_are_rejected(self):
        runtime = Runtime({})
        _, decoder = make_decoder(runtime)
        for prompt in ("hello", "<|fim_prefix|>x<|fim_middle|>"):
            with self.subTest(prompt=prompt), self.assertRaises(ValueError):
                decoder.generate(prompt)
        for max_tokens in (-1, 513, True):
            with self.subTest(max_tokens=max_tokens), self.assertRaises(ValueError):
                decoder.generate("<|fim_prefix|>x<|fim_suffix|>y<|fim_middle|>", max_tokens)

    def test_eos_is_not_returned_as_text_or_completion_usage(self):
        prompt = "<|fim_prefix|>x<|fim_suffix|>y<|fim_middle|>"
        runtime = Runtime({prompt: "ok"})
        _, decoder = make_decoder(runtime)

        result = decoder.generate(prompt, max_tokens=5)

        self.assertEqual(result["text"], "ok")
        self.assertEqual(result["tokens"], list(map(ord, "ok")))
        self.assertEqual(result["finish_reason"], "stop")
        self.assertEqual(result["usage"]["completion_tokens"], 2)

    def test_fourth_positional_callback_cancels_after_decoding_starts(self):
        prompt = "<|fim_prefix|>x<|fim_suffix|>y<|fim_middle|>"
        runtime = Runtime({prompt: "right"})
        module, decoder = make_decoder(runtime)

        def cancel_after_a_token():
            return bool(runtime.processor_histories)

        with self.assertRaises(module.GenerationCancelled):
            decoder.generate(prompt, 192, None, cancel_after_a_token)

        self.assertEqual(len(runtime.processor_histories), 1)
        self.assertEqual(decoder.cached_tokens, list(map(ord, prompt)))
        self.assert_cache_coherent(decoder)
        result = decoder.generate(prompt, max_tokens=10)
        self.assertEqual(result["text"], "right")
        self.assertEqual(result["finish_reason"], "stop")
        self.assertEqual(result["cache"]["cached_prompt_tokens"], len(prompt) - 1)

    def test_cancellation_reuses_cache_and_model_error_invalidates_before_recovery(self):
        prompt = "<|fim_prefix|>x<|fim_suffix|>y<|fim_middle|>"
        runtime = Runtime({prompt: "right"})
        module, decoder = make_decoder(runtime)
        checks = 0

        def cancel_after_a_token():
            nonlocal checks
            checks += 1
            return checks >= 3

        with self.assertRaises(module.GenerationCancelled):
            decoder.generate(prompt, max_tokens=10, cancelled=cancel_after_a_token)
        cancelled_cache = runtime.caches[-1]
        self.assertIs(cancelled_cache(), decoder.cache[0])
        self.assert_cache_coherent(decoder)
        runtime.model.fail_next = True
        with self.assertRaisesRegex(RuntimeError, "synthetic model failure"):
            decoder.generate(prompt, max_tokens=10)
        error_cache = runtime.caches[-1]
        self.assertEqual(decoder.cached_tokens, [])
        self.assertEqual(decoder.cache[0].tokens, [])
        result = decoder.generate(prompt, max_tokens=10)

        self.assertEqual(result["text"], "right")
        self.assertIsNone(cancelled_cache())
        self.assertIs(error_cache(), decoder.cache[0])
        self.assertEqual(result["cache"]["cached_prompt_tokens"], 0)
        self.assert_cache_coherent(decoder)

    def test_retained_cache_is_coherent_during_allocator_reclaim_on_every_outcome(self):
        for outcome in ("length", "eos", "stop", "zero", "cancel_prefill",
                        "cancel_partial_prefill", "cancel_decode", "fail_prefill", "fail_decode"):
            with self.subTest(outcome=outcome):
                prefix = "x" * 600 if outcome == "cancel_partial_prefill" else "x"
                prompt = f"<|fim_prefix|>{prefix}<|fim_suffix|>y<|fim_middle|>"
                runtime = Runtime({prompt: "abcENDtail"}, context_length=2048)
                module, decoder = make_decoder(runtime)
                primary_error = RuntimeError("request forward failed")
                prefill = decoder._prefill
                prefill_token = decoder._prefill_token
                forwards = 0
                checks = 0
                observed = []

                def forward(chunk, evaluate=prefill):
                    nonlocal forwards
                    forwards += 1
                    logits = evaluate(chunk)
                    if ((outcome == "fail_prefill" and forwards == 1)
                            or (outcome == "fail_decode" and forwards == 2)):
                        raise primary_error
                    return logits

                def cancelled():
                    nonlocal checks
                    checks += 1
                    return ((outcome == "cancel_prefill" and checks == 1)
                            or (outcome == "cancel_partial_prefill" and checks == 2)
                            or (outcome == "cancel_decode" and checks == 3))

                def assert_coherent():
                    self.assert_cache_coherent(decoder)
                    self.assertIs(runtime.caches[-1](), decoder.cache[0])
                    self.assertTrue(all(cache() is None for cache in runtime.caches[:-1]))
                    if outcome.startswith("fail") or outcome == "cancel_prefill":
                        self.assertEqual(decoder.cached_tokens, [])
                    elif outcome == "cancel_partial_prefill":
                        self.assertEqual(decoder.cached_tokens, list(map(ord, prompt[:512])))
                    else:
                        self.assertEqual(decoder.cached_tokens[:len(prompt)], list(map(ord, prompt)))

                def synchronize(*streams):
                    if streams:
                        self.assertEqual(streams, (decoder.stream,))
                        observed.append("drain")
                        return
                    assert_coherent()
                    observed.append("sync")

                def clear_cache():
                    assert_coherent()
                    observed.append("clear")
                    allocator_memory["cache"] = 0

                core = runtime.modules["mlx.core"]
                allocator_memory = {"cache": decoder.cache_limit_bytes + 1}
                options = dict(max_tokens=12, cancelled=cancelled)
                if outcome == "length":
                    options["max_tokens"] = 2
                elif outcome == "zero":
                    options["max_tokens"] = 0
                elif outcome == "stop":
                    options["stop"] = "END"
                with patch.object(decoder, "_prefill", side_effect=forward), \
                        patch.object(decoder, "_prefill_token",
                                     side_effect=lambda token: forward(token, prefill_token)), \
                        patch.object(core, "synchronize", side_effect=synchronize), \
                        patch.object(core, "clear_cache", side_effect=clear_cache), \
                        patch.object(core, "get_cache_memory",
                                     side_effect=lambda: allocator_memory["cache"]):
                    if outcome.startswith("cancel"):
                        with self.assertRaises(module.GenerationCancelled):
                            decoder.generate(prompt, **options)
                    elif outcome.startswith("fail"):
                        with self.assertRaises(RuntimeError) as caught:
                            decoder.generate(prompt, **options)
                        self.assertIs(caught.exception, primary_error)
                    else:
                        result = decoder.generate(prompt, **options)
                        expected = {"length": "ab", "eos": "abcENDtail",
                                    "stop": "abc", "zero": ""}[outcome]
                        self.assertEqual(result["text"], expected)
                        self.assertEqual(result["memory"]["kv_cache_bytes"],
                                         len(decoder.cached_tokens) * 8)
                self.assertEqual(observed, (["drain"] if outcome in (
                    "stop", "eos", "cancel_decode", "fail_decode") else [])
                                 + ["sync", "clear"])
                if outcome == "cancel_partial_prefill":
                    self.assertEqual(forwards, 1)
                # Every terminal path must leave a cache that can serve the next
                # request correctly, even when the last sampled token was never
                # evaluated or a partial prompt was retained on cancellation.
                recovered = decoder.generate(prompt, max_tokens=12)
                self.assertEqual(recovered["text"], "abcENDtail")
                self.assert_cache_coherent(decoder)

    def test_reclaim_failure_preserves_primary_qwen_exception(self):
        prompt = "<|fim_prefix|>x<|fim_suffix|>y<|fim_middle|>"
        for outcome in ("failure", "cancellation", "success"):
            with self.subTest(outcome=outcome):
                runtime = Runtime({prompt: "ok"})
                module, decoder = make_decoder(runtime)
                primary_error = RuntimeError("primary model error")
                cleanup_error = RuntimeError("allocator cleanup error")

                def fail_forward(chunk):
                    raise primary_error

                if outcome == "failure":
                    decoder._prefill = fail_forward

                def reclaim():
                    self.assert_cache_coherent(decoder)
                    if outcome != "success":
                        self.assertEqual(decoder.cached_tokens, [])
                    else:
                        self.assertEqual(decoder.cached_tokens, list(map(ord, prompt + "ok")))
                    raise cleanup_error

                with patch.object(decoder.allocator, "reclaim", side_effect=reclaim):
                    with self.assertRaises(Exception) as caught:
                        decoder.generate(prompt, max_tokens=4,
                                         cancelled=lambda: outcome == "cancellation")
                if outcome == "failure":
                    self.assertIs(caught.exception, primary_error)
                elif outcome == "cancellation":
                    self.assertIsInstance(caught.exception, module.GenerationCancelled)
                else:
                    self.assertIs(caught.exception, cleanup_error)
                if outcome != "success":
                    self.assertIn("Allocator cleanup failed: allocator cleanup error",
                                  caught.exception.__notes__)


if __name__ == "__main__":
    unittest.main()
