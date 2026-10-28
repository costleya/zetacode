"""gRPC service contracts without loading MLX models."""

import builtins
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import io
import os
from pathlib import Path
import sys
import threading
import types
import unittest
from typing import Any, cast
from unittest.mock import Mock, patch

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanContext
from opentelemetry.util.types import AnyValue


def load_server() -> Any:
    """Load the production service while replacing only the model modules."""
    source = Path(__file__).resolve().parents[1] / "src"
    decoder = types.ModuleType("decoder")
    setattr(decoder, "Decoder", Mock())
    setattr(decoder, "MLXAllocator", Mock())
    setattr(
        decoder,
        "GenerationCancelled",
        type("GenerationCancelled", (InterruptedError,), {}),
    )

    def nonnegative_int(value: int | str) -> int:
        parsed = int(value)
        if parsed < 0:
            raise ValueError("must be nonnegative")
        return parsed

    setattr(decoder, "nonnegative_int", nonnegative_int)
    continuation_decoder = types.ModuleType("continuation_decoder")
    setattr(continuation_decoder, "ContinuationDecoder", Mock())
    spec = importlib.util.spec_from_file_location(
        "zeta_grpc_server_contract", source / "server.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load server module")
    module = importlib.util.module_from_spec(spec)
    missing = object()
    original_decoder = sys.modules.get("decoder", missing)
    original_continuation = sys.modules.get("continuation_decoder", missing)
    sys.modules["decoder"] = decoder
    sys.modules["continuation_decoder"] = continuation_decoder
    try:
        with patch.object(sys, "path", [str(source), *sys.path]):
            spec.loader.exec_module(module)
    finally:
        for name, original in (("decoder", original_decoder),
                               ("continuation_decoder", original_continuation)):
            if original is missing:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = cast(types.ModuleType, original)
    return module


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server_module = load_server()
        cls.pb2 = cls.server_module.completion_pb2

    def service(self, decoder: Any = None, continuation_decoder: Any = None) -> Any:
        decoder = decoder if decoder is not None else Mock()
        continuation_decoder = (continuation_decoder if continuation_decoder is not None
                                else Mock())
        return self.server_module.CompletionService(decoder, continuation_decoder)

    def test_residency_interval_is_defaulted_before_decoder_import(self):
        original_import = builtins.__import__
        for inherited, expected in ((None, '1000'), ('0', '0'), ('2500', '2500')):
            with self.subTest(inherited=inherited), patch.dict(os.environ):
                os.environ.pop('MLX_METAL_RESIDENCY_REFRESH_INTERVAL_MS', None)
                if inherited is not None:
                    os.environ['MLX_METAL_RESIDENCY_REFRESH_INTERVAL_MS'] = inherited
                observed: list[str | None] = []

                def observe_import(name: str, *args: Any, **kwargs: Any) -> Any:
                    if name == 'decoder':
                        observed.append(os.environ.get('MLX_METAL_RESIDENCY_REFRESH_INTERVAL_MS'))
                    return original_import(name, *args, **kwargs)

                with patch('builtins.__import__', side_effect=observe_import):
                    load_server()
                self.assertEqual(observed, [expected])

    def test_residency_is_configured_once_after_both_models_load(self):
        module = self.server_module
        events: list[object] = []
        allocator = Mock()

        def record_residency(interval: str) -> None:
            events.append(('wire', interval))

        def resolve_model(model: str, _: Any) -> str:
            return model

        allocator.configure_residency.side_effect = record_residency
        zeta, qwen = Mock(), Mock()
        zeta.memory_snapshot.return_value = {}
        qwen.memory_snapshot.return_value = {}

        def load_model(label: str, model: Any) -> Any:
            def loaded(*args: Any, **kwargs: Any) -> Any:
                self.assertIs(kwargs['allocator'], allocator)
                events.append(label)
                return model
            return loaded

        with patch.dict(os.environ, {'MLX_METAL_RESIDENCY_REFRESH_INTERVAL_MS': '1500'}), \
                patch.object(sys, 'argv', ['server.py', '--socket-path', '/tmp/residency-test.sock']), \
                patch.object(module, 'MLXAllocator', return_value=allocator) as factory, \
                patch.object(module, 'Decoder', side_effect=load_model('zeta', zeta)), \
                patch.object(module, 'ContinuationDecoder', side_effect=load_model('qwen', qwen)), \
                patch.object(module, 'SetupProgress'), \
                patch.object(module, 'PrivateUnixSocket'), \
                patch.object(module, 'resolve_model', side_effect=resolve_model), \
                patch.object(module, 'CompletionService'), \
                patch.object(module, 'create_server'), \
                patch('sys.stdout', new_callable=io.StringIO):
            module.main()
        factory.assert_called_once_with(256)
        allocator.configure_residency.assert_called_once_with('1500')
        self.assertEqual(events, ['zeta', 'qwen', ('wire', '1500')])

    def test_w3c_parentage_is_isolated_across_concurrent_requests_and_export_is_private(self):
        source = Path(__file__).resolve().parents[1] / "src"
        with patch.object(sys, "path", [str(source), *sys.path]):
            import observability

        observability.shutdown_tracing()
        exporter = InMemorySpanExporter()
        provider = TracerProvider()
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        observability.configure_tracing(provider)
        service = None
        rendezvous = threading.Barrier(2)
        worker_contexts: list[int] = []
        contexts_lock = threading.Lock()

        def generate(*args: Any, **kwargs: Any) -> dict[str, object]:
            span_context = trace.get_current_span().get_span_context()
            with contexts_lock:
                worker_contexts.append(span_context.trace_id)
            rendezvous.wait(timeout=3)
            with observability.span_scope("decoder.prefill"):
                pass
            with observability.span_scope("decoder.decode"):
                pass
            return {
                "text": "private completion output",
                "finish_reason": "stop",
                "usage": {"prompt_tokens": 5, "completion_tokens": 2},
                "memory": {"active_bytes": 123, "model_path": "/private/model/path"},
                "cache": {"cached_prompt_tokens": 1},
                "draft_stats": {"accepted_tokens": 1},
                "prompt_sha256": "private prompt digest",
            }

        decoder = Mock()
        decoder.generate.side_effect = generate
        service = self.service(decoder=decoder)

        def metadata(trace_id: int, span_id: int) -> tuple[tuple[str, str], ...]:
            return (
                ("traceparent", f"00-{trace_id:032x}-{span_id:016x}-01"),
                ("tracestate", "vendor=value"),
            )

        def request_context(request_metadata: tuple[tuple[str, str], ...]) -> Any:
            return _ActiveContext(metadata=request_metadata)

        def invoke(request_metadata: tuple[tuple[str, str], ...]) -> list[Any]:
            request = self.pb2.CompletionRequest(
                model="zeta-2.1", prompt="private prompt", temperature=0)
            return list(service.Complete(request, request_context(request_metadata)))

        try:
            with ThreadPoolExecutor(max_workers=2) as callers:
                results = [
                    callers.submit(invoke, metadata(0x1111, 0xAAAA)),
                    callers.submit(invoke, metadata(0x2222, 0xBBBB)),
                ]
                for future in results:
                    self.assertEqual(len(future.result(timeout=5)), 1)

            self.assertCountEqual(worker_contexts, [0x1111, 0x2222])
            spans = exporter.get_finished_spans()
            roots = [span for span in spans if span.name == "nesweep.CompletionService/Complete"]
            generations = [span for span in spans if span.name == "completion.generate"]
            self.assertEqual(len(roots), 2)
            self.assertEqual(len(generations), 2)
            for root in roots:
                self.assertEqual(root.kind.name, "SERVER")
                root_context = cast(SpanContext, root.context)
                expected_remote_parent = {
                    0x1111: 0xAAAA,
                    0x2222: 0xBBBB,
                }[root_context.trace_id]
                self.assertEqual(cast(SpanContext, root.parent).span_id, expected_remote_parent)
                generation = next(
                    span for span in generations
                    if cast(SpanContext, span.context).trace_id == root_context.trace_id
                )
                self.assertEqual(
                    cast(SpanContext, generation.parent).span_id,
                    root_context.span_id,
                )
                for name in ("decoder.prefill", "decoder.decode"):
                    child = next(span for span in spans
                                 if span.name == name
                                 and cast(SpanContext, span.context).trace_id == root_context.trace_id)
                    self.assertEqual(
                        cast(SpanContext, child.parent).span_id,
                        cast(SpanContext, generation.context).span_id,
                    )
                self.assertEqual(
                    cast(Mapping[str, AnyValue], root.attributes)["nesweep.outcome"],
                    "success",
                )

            private_values = (
                "private prompt", "private completion output", "/private/model/path",
                "private prompt digest", "vendor=value",
            )
            for span in spans:
                serialized = repr((span.name, span.attributes, span.events))
                for value in private_values:
                    self.assertNotIn(value, serialized)
        finally:
            if service is not None:
                service.shutdown()
            observability.shutdown_tracing()

    def test_invalid_and_absent_trace_metadata_start_without_a_parent(self):
        source = Path(__file__).resolve().parents[1] / "src"
        with patch.object(sys, "path", [str(source), *sys.path]):
            import observability

        observability.shutdown_tracing()
        exporter = InMemorySpanExporter()
        provider = TracerProvider()
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        observability.configure_tracing(provider)
        decoder = Mock()
        decoder.generate.return_value = {"text": "ok", "finish_reason": "stop", "usage": {}}
        service = self.service(decoder=decoder)
        try:
            request_metadata_values = (
                (("traceparent", "00-00000000000000000000000000003333-000000000000cccc-01"),),
                (("traceparent", "not-a-valid-traceparent"),),
                (),
            )
            for request_metadata in request_metadata_values:
                request = self.pb2.CompletionRequest(
                    model="zeta-2.1", prompt="private prompt", temperature=0)
                list(service.Complete(request, _ActiveContext(metadata=request_metadata)))
            roots = [span for span in exporter.get_finished_spans()
                     if span.name == "nesweep.CompletionService/Complete"]
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
        finally:
            service.shutdown()
            observability.shutdown_tracing()

    def test_health_is_ready_only_when_both_models_are_available(self):
        service = self.service()
        self.addCleanup(service.shutdown)
        ready = service.Health(self.pb2.HealthRequest(), None)
        self.assertTrue(ready.ready)
        self.assertEqual(list(ready.models), [
            "zeta-2.1", "qwen2.5-coder-7b-instruct"])

        unavailable_service = self.server_module.CompletionService(Mock(), None)
        self.addCleanup(unavailable_service.shutdown)
        unavailable = unavailable_service.Health(
            self.pb2.HealthRequest(), None)
        self.assertFalse(unavailable.ready)
        self.assertEqual(list(unavailable.models), [])

    def test_completion_defaults_only_omitted_generation_fields(self):
        decoder = Mock()
        decoder.generate.return_value = {
            "text": "replacement", "finish_reason": "stop", "usage": {}}
        service = self.service(decoder=decoder)
        self.addCleanup(service.shutdown)
        request = self.pb2.CompletionRequest(
            model="zeta-2.1", prompt="source", temperature=0)
        events = list(service.Complete(request, _ActiveContext()))

        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].WhichOneof("event"), "final_result")
        self.assertEqual(events[0].final_result.text, "replacement")
        self.assertEqual(decoder.generate.call_args.args, ("source",))
        options = decoder.generate.call_args.kwargs
        self.assertEqual(options["max_tokens"], 2048)
        self.assertEqual(options["stop"], [])
        self.assertEqual(options["mode"], "source")
        self.assertEqual(options["draft_size"], 96)
        self.assertNotIn("on_first_token", options)
        self.assertNotIn("on_no_edit_impossible", options)

        request.max_tokens = 0
        decoder.generate.reset_mock()
        list(service.Complete(request, _ActiveContext()))
        self.assertEqual(decoder.generate.call_args.kwargs["max_tokens"], 0)

class _ActiveContext:
    def __init__(self, metadata: tuple[tuple[str, str], ...] = ()) -> None:
        self.active = True
        self.callback = None
        self.metadata = metadata

    def time_remaining(self) -> None:
        return None

    def add_callback(self, callback: Any) -> bool:
        self.callback = callback
        return True

    def invocation_metadata(self) -> tuple[tuple[str, str], ...]:
        return self.metadata

    def is_active(self) -> bool:
        return self.active

    def abort(self, code: Any, details: str) -> None:
        raise AssertionError(f"unexpected RPC abort: {code}: {details}")


if __name__ == "__main__":
    unittest.main()
