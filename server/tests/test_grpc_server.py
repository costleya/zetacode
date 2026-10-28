"""Model-free gRPC wire tests for completion, fallback, cancellation and health."""

from concurrent.futures import ThreadPoolExecutor
import tempfile
import threading
import time
import unittest
from collections.abc import Mapping
from typing import Any, cast
from unittest.mock import patch

import grpc
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanContext, StatusCode
from opentelemetry.util.types import AnyValue

from test_server import load_server


server_module = load_server()
completion_pb2 = server_module.completion_pb2
completion_pb2_grpc = server_module.completion_pb2_grpc


def result(text: str, *, prompt_tokens: int | None = None,
           completion_tokens: int | None = None) -> dict[str, object]:
    usage: dict[str, int] = {}
    if prompt_tokens is not None:
        usage["prompt_tokens"] = prompt_tokens
    if completion_tokens is not None:
        usage["completion_tokens"] = completion_tokens
    return {"text": text, "finish_reason": "stop", "usage": usage}


class _SpanCountExporter(InMemorySpanExporter):
    def __init__(self, expected_count: int) -> None:
        super().__init__()
        self.expected_count = expected_count
        self.finished = threading.Event()

    def export(self, spans: Any) -> Any:
        result = super().export(spans)
        if len(self.get_finished_spans()) >= self.expected_count:
            self.finished.set()
        return result


class GrpcServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory(prefix="nes-grpc-", dir="/tmp")
        self.addCleanup(self.directory.cleanup)
        self.socket_path = self.directory.name + "/completion.sock"
        self.decoder = _FakeDecoder()
        self.continuation_decoder = _FakeDecoder()
        self.service = server_module.CompletionService(
            self.decoder, self.continuation_decoder, request_timeout=5)
        self.server = server_module.create_server(self.socket_path, self.service).start()
        self.addCleanup(self.server.stop, 0)
        self.channel = grpc.insecure_channel("unix:" + self.socket_path)
        self.addCleanup(self.channel.close)
        grpc.channel_ready_future(self.channel).result(timeout=3)
        self.stub = completion_pb2_grpc.CompletionServiceStub(self.channel)

    def capture_spans(
        self, expected_count: int | None = None
    ) -> _SpanCountExporter | InMemorySpanExporter:
        observability = server_module.observability
        observability.shutdown_tracing()
        exporter = (_SpanCountExporter(expected_count) if expected_count is not None
                    else InMemorySpanExporter())
        provider = TracerProvider()
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        observability.configure_tracing(provider)
        self.addCleanup(observability.shutdown_tracing)
        self.addCleanup(self.server.stop, 0)
        return exporter

    def test_real_wire_metadata_rejects_invalid_and_absent_context_without_leakage(self):
        exporter = self.capture_spans()

        def complete(metadata: tuple[tuple[str, str], ...] | None = None) -> list[Any]:
            request = completion_pb2.CompletionRequest(
                model="zeta-2.1", prompt="private prompt", temperature=0)
            if metadata is None:
                return list(self.stub.Complete(request))
            return list(self.stub.Complete(request, metadata=metadata))

        def return_private_completion(*args: Any, **kwargs: Any) -> dict[str, object]:
            return result("private completion")

        self.decoder.generate = return_private_completion
        complete((
            ("traceparent", "00-00000000000000000000000000003333-000000000000cccc-01"),
            ("tracestate", "vendor=value"),
        ))
        complete((("traceparent", "not-a-valid-traceparent"),))
        complete()

        roots = [span for span in exporter.get_finished_spans()
                 if span.name == "zetacode.CompletionService/Complete"]
        self.assertEqual(len(roots), 3)
        valid = next(
            span for span in roots
            if cast(SpanContext, span.context).trace_id == 0x3333
        )
        self.assertEqual(cast(SpanContext, valid.parent).span_id, 0xCCCC)
        invalid_and_absent = [span for span in roots if span is not valid]
        self.assertTrue(all(span.parent is None for span in invalid_and_absent))
        self.assertEqual(
            len({cast(SpanContext, span.context).trace_id for span in roots}),
            3,
        )

    def test_zeta_completion_streams_each_opted_in_milestone_once_before_result(self):
        self.decoder.result = result("complete edit", prompt_tokens=12, completion_tokens=3)

        def generate(prompt: str, **options: Any) -> dict[str, object]:
            self.decoder.calls.append((prompt, {
                key: value for key, value in options.items()
                if key not in ("cancelled", "on_first_token", "on_no_edit_impossible")
            }))
            options["on_first_token"]()
            options["on_first_token"]()
            options["on_no_edit_impossible"]()
            options["on_no_edit_impossible"]()
            return self.decoder.result

        self.decoder.generate = generate
        request = completion_pb2.CompletionRequest(
            model="zeta-2.1", prompt="full source prompt", temperature=0,
            repeat_penalty=1.0, max_tokens=4096, stop=["\n\n", "<|endoftext|>"],
            notify_first_token=True, notify_no_edit_impossible=True)

        events = list(self.stub.Complete(request))

        self.assertEqual([event.WhichOneof("event") for event in events], [
            "first_token", "no_edit_impossible", "final_result"])
        final = events[-1].final_result
        self.assertEqual((final.text, final.finish_reason), ("complete edit", "stop"))
        self.assertTrue(final.HasField("prompt_eval_count"))
        self.assertTrue(final.HasField("eval_count"))
        self.assertEqual((final.prompt_eval_count, final.eval_count), (12, 3))
        self.assertEqual(self.decoder.calls, [("full source prompt", {
            "max_tokens": 4096,
            "stop": ["\n\n", "<|endoftext|>"],
            "mode": "source",
            "draft_size": 96,
        })])

    def test_qwen_request_preserves_raw_fim_prompt_and_supported_generation_options(self):
        self.continuation_decoder.result = result(
            "inner()", prompt_tokens=9, completion_tokens=2)
        request = completion_pb2.CompletionRequest(
            model="qwen2.5-coder-7b-instruct",
            prompt="<|fim_prefix|>// 😀\nouter(<|fim_suffix|>)<|fim_middle|>",
            temperature=0, repeat_penalty=1.1, max_tokens=192,
            stop=["\n\n", "<|endoftext|>"], notify_first_token=True,
            notify_no_edit_impossible=True)

        events = list(self.stub.Complete(request))

        self.assertEqual([event.WhichOneof("event") for event in events], ["final_result"])
        self.assertEqual(events[0].final_result.text, "inner()")
        self.assertEqual(self.continuation_decoder.calls, [(request.prompt, {
            "max_tokens": 192,
            "stop": ["\n\n", "<|endoftext|>"],
        })])

    def test_progress_notifications_are_silent_without_opt_in(self):
        self.decoder.result = result("complete edit")
        request = completion_pb2.CompletionRequest(
            model="zeta-2.1", prompt="source", temperature=0)

        events = list(self.stub.Complete(request))

        self.assertEqual([event.WhichOneof("event") for event in events], ["final_result"])

    def test_deadline_after_first_token_progress_aborts_generation(self):
        exporter = self.capture_spans(expected_count=2)
        entered = threading.Event()
        observed_cancel = threading.Event()

        def generate(prompt: str, **options: Any) -> dict[str, object]:
            options["on_first_token"]()
            entered.set()
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                if options["cancelled"]():
                    observed_cancel.set()
                    raise server_module.GenerationCancelled("deadline expired")
                observed_cancel.wait(0.005)
            raise AssertionError("decoder did not observe the RPC deadline")

        self.decoder.generate = generate
        request = completion_pb2.CompletionRequest(
            model="zeta-2.1", prompt="source", temperature=0, notify_first_token=True)
        call = self.stub.Complete(request, timeout=0.5)

        first = next(call)
        self.assertEqual(first.WhichOneof("event"), "first_token")
        self.assertTrue(entered.wait(timeout=1))
        with self.assertRaises(grpc.RpcError) as caught:
            next(call)
        self.assertEqual(caught.exception.code(), grpc.StatusCode.DEADLINE_EXCEEDED)
        self.assertTrue(observed_cancel.wait(timeout=1))

        self.assertTrue(cast(_SpanCountExporter, exporter).finished.wait(timeout=2))
        self.service.shutdown()

        spans = exporter.get_finished_spans()
        self.assertCountEqual(
            [
                (span.name, cast(Mapping[str, AnyValue], span.attributes).get(
                    "zetacode.outcome"))
                for span in spans
            ],
            [("zetacode.CompletionService/Complete", "cancelled"),
             ("completion.generate", "cancelled")])
        for span in spans:
            self.assertNotIn("deadline expired", repr((span.name, span.attributes, span.events)))

    def test_health_reports_both_model_ids_and_concurrent_models_generate_together(self):
        health = self.stub.Health(completion_pb2.HealthRequest())
        self.assertTrue(health.ready)
        self.assertEqual(list(health.models), [
            "zeta-2.1", "qwen2.5-coder-7b-instruct"])
        barrier = threading.Barrier(2, timeout=2)

        def generate(text: str) -> Any:
            def run(prompt: str, **options: Any) -> dict[str, object]:
                barrier.wait()
                return result(text)
            return run

        self.decoder.generate = generate("zeta")
        self.continuation_decoder.generate = generate("qwen")
        requests = (
            completion_pb2.CompletionRequest(model="zeta-2.1", prompt="source"),
            completion_pb2.CompletionRequest(
                model="qwen2.5-coder-7b-instruct",
                prompt="<|fim_prefix|>x<|fim_suffix|>y<|fim_middle|>"),
        )

        def complete(request: Any) -> str:
            return list(self.stub.Complete(request))[-1].final_result.text

        with ThreadPoolExecutor(max_workers=2) as workers:
            results = list(workers.map(complete, requests))
        self.assertEqual(results, ["zeta", "qwen"])

    def test_omitted_repeat_penalty_and_max_tokens_use_model_defaults(self):
        zeta = completion_pb2.CompletionRequest(
            model="zeta-2.1", prompt="source", temperature=0)
        qwen = completion_pb2.CompletionRequest(
            model="qwen2.5-coder-7b-instruct",
            prompt="<|fim_prefix|>x<|fim_suffix|>y<|fim_middle|>", temperature=0)

        list(self.stub.Complete(zeta))
        list(self.stub.Complete(qwen))

        self.assertEqual(self.decoder.calls[-1][1]["max_tokens"], 2048)
        self.assertEqual(self.continuation_decoder.calls[-1][1]["max_tokens"], 192)

    def test_invalid_model_and_generation_options_return_invalid_argument(self):
        valid = dict(model="zeta-2.1", prompt="source", temperature=0)
        invalid_requests = (
            {**valid, "model": "another-model"},
            {**valid, "prompt": ""},
            {**valid, "temperature": 0.1},
            {**valid, "temperature": float("nan")},
            {**valid, "repeat_penalty": 1.1},
            {**valid, "model": "qwen2.5-coder-7b-instruct",
             "prompt": "<|fim_prefix|>x<|fim_suffix|>y<|fim_middle|>",
             "repeat_penalty": 1.0},
            {**valid, "max_tokens": -1},
            {**valid, "stop": [""]},
        )
        for fields in invalid_requests:
            with self.subTest(fields=fields):
                with self.assertRaises(grpc.RpcError) as caught:
                    list(self.stub.Complete(completion_pb2.CompletionRequest(**fields)))
                self.assertEqual(caught.exception.code(), grpc.StatusCode.INVALID_ARGUMENT)
        self.assertEqual(self.decoder.calls, [])
        self.assertEqual(self.continuation_decoder.calls, [])

    def test_cancellation_reaches_decoder_and_service_accepts_next_request(self):
        entered = threading.Event()
        cancelled = threading.Event()

        def wait_for_cancel(prompt: str, **options: Any) -> dict[str, object]:
            entered.set()
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                if options["cancelled"]():
                    cancelled.set()
                    raise server_module.GenerationCancelled("client cancelled")
                cancelled.wait(0.005)
            raise AssertionError("decoder did not observe gRPC cancellation")

        self.decoder.generate = wait_for_cancel
        call = self.stub.Complete(completion_pb2.CompletionRequest(
            model="zeta-2.1", prompt="first request", temperature=0))
        self.assertTrue(entered.wait(timeout=2))
        call.cancel()
        self.assertTrue(cancelled.wait(timeout=2))

        self.decoder.generate = lambda prompt, **options: result("recovered")
        events = list(self.stub.Complete(completion_pb2.CompletionRequest(
            model="zeta-2.1", prompt="request after cancellation", temperature=0)))
        self.assertEqual(events[-1].final_result.text, "recovered")

    def test_inference_failures_are_sanitized_as_internal(self):
        exporter = self.capture_spans()
        def raise_private_model_error(*args: Any, **kwargs: Any) -> dict[str, object]:
            raise RuntimeError("private model path")

        self.decoder.generate = raise_private_model_error
        logger = server_module.logging.getLogger(server_module.__name__)
        with patch.object(logger, "error") as log_error, \
                self.assertRaises(grpc.RpcError) as caught:
            list(self.stub.Complete(completion_pb2.CompletionRequest(
                model="zeta-2.1", prompt="source", temperature=0)))
        self.assertEqual(caught.exception.code(), grpc.StatusCode.INTERNAL)
        self.assertNotIn("private model path", cast(str, caught.exception.details()))
        log_error.assert_called_once()

        spans = exporter.get_finished_spans()
        generation = next(span for span in spans if span.name == "completion.generate")
        self.assertEqual(
            cast(Mapping[str, AnyValue], generation.attributes)["error.type"],
            "RuntimeError",
        )
        self.assertEqual(generation.status.status_code, StatusCode.ERROR)
        self.assertTrue(any(span.name == "zetacode.CompletionService/Complete"
                            for span in spans))
        for span in spans:
            self.assertNotIn("private model path",
                             repr((span.name, span.attributes, span.events)))


class _FakeDecoder:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, object]]] = []
        self.result = result("local output")

    def generate(self, prompt: str, **options: Any) -> dict[str, object]:
        callbacks: dict[str, Any] = {
            key: options.pop(key)
            for key in ("cancelled", "on_first_token", "on_no_edit_impossible")
            if key in options
        }
        self.calls.append((prompt, dict(options)))
        if "on_first_token" in callbacks:
            callbacks["on_first_token"]()
        return self.result


if __name__ == "__main__":
    unittest.main()
