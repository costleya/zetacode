"""Private tracing contracts without requiring an OTLP collector."""

import importlib.util
import io
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode


SOURCE = Path(__file__).resolve().parents[1] / "src"
if str(SOURCE) not in sys.path:
    sys.path.insert(0, str(SOURCE))

import observability


def load_isolated_observability(name):
    spec = importlib.util.spec_from_file_location(name, SOURCE / "observability.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ObservabilityTests(unittest.TestCase):
    def setUp(self):
        observability.shutdown_tracing()
        self.exporter = InMemorySpanExporter()
        self.provider = TracerProvider()
        self.provider.add_span_processor(SimpleSpanProcessor(self.exporter))
        observability.configure_tracing(self.provider)

    def tearDown(self):
        observability.shutdown_tracing()

    def test_completed_error_and_cancelled_spans_end_without_sensitive_values(self):
        class GenerationCancelled(Exception):
            pass

        with observability.span_scope("decoder.prefill"):
            pass

        with self.assertRaisesRegex(RuntimeError, "private raw failure"):
            with observability.span_scope("decoder.decode"):
                raise RuntimeError("private raw failure")

        with self.assertRaises(GenerationCancelled):
            with observability.span_scope("completion.generate"):
                raise GenerationCancelled("private prompt and completion")

        spans = self.exporter.get_finished_spans()
        self.assertEqual({span.name for span in spans}, {
            "decoder.prefill", "decoder.decode", "completion.generate"})
        self.assertEqual({span.attributes["nesweep.outcome"] for span in spans}, {
            "success", "error", "cancelled"})
        error = next(span for span in spans if span.name == "decoder.decode")
        self.assertEqual(error.status.status_code, StatusCode.ERROR)
        self.assertEqual(error.attributes["error.type"], "RuntimeError")
        self.assertFalse(error.events)
        cancelled = next(span for span in spans if span.name == "completion.generate")
        self.assertEqual(cancelled.status.status_code, StatusCode.UNSET)
        for span in spans:
            serialized = repr((span.name, span.attributes, span.events))
            for secret in ("private raw failure", "private prompt", "private completion"):
                self.assertNotIn(secret, serialized)

    def test_result_attributes_include_only_numeric_counts_and_memory(self):
        span = observability.start_span("completion.generate")
        try:
            observability.record_result(span, {
                "text": "private completion",
                "prompt_sha256": "private prompt digest",
                "usage": {"prompt_tokens": 8, "completion_tokens": 3},
                "memory": {"active_bytes": 100, "model_path": "/private/model"},
                "cache": {"cached_prompt_tokens": 2},
                "draft_stats": {"accepted_tokens": 1},
            })
        finally:
            span.end()

        recorded, = self.exporter.get_finished_spans()
        self.assertEqual(recorded.attributes, {
            "nesweep.usage.prompt_tokens": 8,
            "nesweep.usage.completion_tokens": 3,
            "nesweep.memory.active_bytes": 100,
            "nesweep.cache.cached_prompt_tokens": 2,
            "nesweep.draft_stats.accepted_tokens": 1,
        })
        serialized = repr((recorded.attributes, recorded.events))
        for secret in ("private completion", "private prompt", "/private/model"):
            self.assertNotIn(secret, serialized)

    def test_default_configuration_uses_private_service_resource_without_exporter(self):
        module = load_isolated_observability("observability_default_test")
        process_provider = trace.get_tracer_provider()
        output = io.StringIO()
        env = {
            key: value for key, value in os.environ.items()
            if not key.startswith("OTEL_")
        }
        console_exporter = module.ConsoleSpanExporter
        with patch.dict(os.environ, env, clear=True), \
                patch.object(module, "ConsoleSpanExporter",
                             side_effect=lambda: console_exporter(out=output)):
            module.configure_tracing()
            span = module.start_span("default-export-disabled")
            span.end()
            self.assertEqual(trace.get_tracer_provider(), process_provider)
            self.assertEqual(output.getvalue(), "")
            try:
                self.assertEqual(module._provider.resource.attributes.get("service.namespace"),
                                 "nesweep")
                self.assertEqual(module._provider.resource.attributes.get("service.name"),
                                 "model-server")
            finally:
                module.shutdown_tracing()

    def test_console_exporter_is_opt_in_and_otlp_requires_explicit_http_endpoint(self):
        console = load_isolated_observability("observability_console_test")
        output = io.StringIO()
        console_exporter = console.ConsoleSpanExporter
        with patch.dict(os.environ, {"OTEL_TRACES_EXPORTER": "console"}, clear=True), \
                patch.object(console, "ConsoleSpanExporter",
                             side_effect=lambda: console_exporter(out=output)):
            console.configure_tracing()
            try:
                span = console.start_span("console-export-opt-in")
                span.end()
            finally:
                console.shutdown_tracing()
        self.assertIn("console-export-opt-in", output.getvalue())

        missing = load_isolated_observability("observability_missing_otlp_test")
        with patch.dict(os.environ, {"OTEL_TRACES_EXPORTER": "otlp"}, clear=True), \
                self.assertLogs("observability_missing_otlp_test", level="WARNING"):
            missing.configure_tracing()
            self.assertIsNone(missing._provider)

        explicit = load_isolated_observability("observability_explicit_otlp_test")
        with patch.dict(os.environ, {
                "OTEL_TRACES_EXPORTER": "otlp",
                "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": "http://127.0.0.1:4318/v1/traces",
                "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL": "http/protobuf",
        }, clear=True):
            explicit.configure_tracing()
            try:
                self.assertIsNotNone(explicit._provider)
            finally:
                explicit.shutdown_tracing()

    def test_shutdown_flush_is_bounded_before_provider_shutdown(self):
        module = load_isolated_observability("observability_shutdown_test")
        provider = Mock()
        module._provider = provider

        module.shutdown_tracing()

        provider.force_flush.assert_called_once_with(timeout_millis=5000)
        provider.shutdown.assert_called_once_with()
        self.assertIsNone(module._provider)

    def test_shutdown_is_fail_soft_and_attempts_provider_shutdown_after_flush_failure(self):
        module = load_isolated_observability("observability_shutdown_failure_test")
        provider = Mock()
        provider.force_flush.side_effect = RuntimeError("private flush failure")
        provider.shutdown.side_effect = RuntimeError("private shutdown failure")
        module._provider = provider

        with self.assertLogs("observability_shutdown_failure_test", level="WARNING") as captured:
            module.shutdown_tracing()

        provider.force_flush.assert_called_once_with(timeout_millis=5000)
        provider.shutdown.assert_called_once_with()
        self.assertIsNone(module._provider)
        self.assertTrue(any("flush failed" in record.getMessage() for record in captured.records))
        self.assertTrue(any("shutdown failed" in record.getMessage() for record in captured.records))
        self.assertNotIn("private", " ".join(record.getMessage() for record in captured.records))


if __name__ == "__main__":
    unittest.main()
