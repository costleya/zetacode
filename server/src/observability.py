"""Private, content-free tracing; never installs a process-global provider."""
from contextlib import contextmanager
import logging
import os
from collections.abc import Mapping, Sequence
from typing import Generator, Protocol, TypedDict, Unpack, cast

from opentelemetry import trace
from opentelemetry.context import Context
from opentelemetry.trace import SpanKind, Status, StatusCode
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, ConsoleSpanExporter
from opentelemetry.util.types import AttributeValue


class _Provider(Protocol):
    def add_span_processor(self, span_processor: object) -> None: ...
    def get_tracer(self, name: str) -> trace.Tracer: ...
    def force_flush(self, timeout_millis: int = 30000) -> bool: ...
    def shutdown(self) -> None: ...


class _StartSpanOptions(TypedDict, total=False):
    context: Context | None
    kind: SpanKind
    attributes: Mapping[str, AttributeValue] | None


_provider: _Provider | None = None
# The SDK's NoOpTracer implementation is not exposed as a Tracer by its stubs.
_tracer: trace.Tracer = cast(trace.Tracer, trace.NoOpTracer())
_propagator = TraceContextTextMapPropagator()


def configure_tracing(provider: object | None = None) -> None:
    """Configure once at startup, or accept a private provider for CPU tests."""
    global _provider, _tracer
    if _provider is not None:
        return
    candidate: _Provider | None = None
    try:
        # The test double and SDK provider share these operations but their
        # narrower SDK parameter and optional arguments do not structurally match.
        candidate = (cast(_Provider, provider) if provider is not None else
                     cast(_Provider, TracerProvider(resource=Resource.create({
                         'service.namespace': 'zetacode', 'service.name': 'model-server'}))))
        if provider is None:
            exporter = os.environ.get('OTEL_TRACES_EXPORTER', 'none').strip().lower()
            if exporter == 'console':
                candidate.add_span_processor(BatchSpanProcessor(ConsoleSpanExporter()))
            elif exporter == 'otlp':
                endpoint = (os.environ.get('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT')
                            or os.environ.get('OTEL_EXPORTER_OTLP_ENDPOINT'))
                protocol = (os.environ.get('OTEL_EXPORTER_OTLP_TRACES_PROTOCOL')
                            or os.environ.get('OTEL_EXPORTER_OTLP_PROTOCOL', 'http/protobuf'))
                if not endpoint or protocol != 'http/protobuf':
                    raise ValueError('explicit HTTP/protobuf endpoint required')
                from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
                candidate.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
            elif exporter != 'none':
                raise ValueError('unsupported exporter')
        _provider = candidate
        _tracer = candidate.get_tracer('zetacode.model-server')
    except Exception:
        if candidate is not None:
            try:
                candidate.shutdown()
            except Exception:
                pass
        logging.getLogger(__name__).warning('Tracing configuration disabled')


def shutdown_tracing() -> None:
    global _provider, _tracer
    provider, _provider = _provider, None
    # The SDK's NoOpTracer implementation is not exposed as a Tracer by its stubs.
    _tracer = cast(trace.Tracer, trace.NoOpTracer())
    if provider is not None:
        try:
            provider.force_flush(timeout_millis=5000)
        except Exception:
            logging.getLogger(__name__).warning('Tracing flush failed')
        finally:
            try:
                provider.shutdown()
            except Exception:
                logging.getLogger(__name__).warning('Tracing shutdown failed')


def extract_metadata(metadata: Sequence[tuple[str, str | bytes]]) -> Context:
    carrier: dict[str, str] = {
        key: value for key, value in metadata
        if key in ('traceparent', 'tracestate') and isinstance(value, str)
    }
    return _propagator.extract(carrier, context=Context())


def start_span(name: str, *, context: Context | None = None,
               kind: SpanKind = SpanKind.INTERNAL,
               attributes: Mapping[str, AttributeValue] | None = None) -> trace.Span:
    return _tracer.start_span(
        name, context=context, kind=kind, attributes=attributes)


def mark_error(span: trace.Span, error: BaseException) -> None:
    span.set_attribute('error.type', type(error).__name__)
    span.set_attribute('zetacode.outcome', 'error')
    span.set_status(Status(StatusCode.ERROR))


@contextmanager
def span_scope(name: str, **kwargs: Unpack[_StartSpanOptions]) -> Generator[trace.Span, None, None]:
    span = start_span(name, **kwargs)
    with trace.use_span(span, end_on_exit=False, record_exception=False,
                        set_status_on_exception=False):
        try:
            yield span
        except BaseException as error:
            if type(error).__name__ in ('GenerationCancelled', 'GeneratorExit'):
                span.set_attribute('zetacode.outcome', 'cancelled')
            else:
                mark_error(span, error)
            raise
        else:
            span.set_attribute('zetacode.outcome', 'success')
        finally:
            span.end()


def record_result(span: trace.Span, result: Mapping[str, object]) -> None:
    fields = {
        'usage': ('prompt_tokens', 'completion_tokens', 'total_tokens'),
        'memory': ('active_bytes', 'cache_bytes', 'peak_bytes', 'kv_cache_bytes',
                   'cache_limit_bytes'),
        'cache': ('cached_prompt_tokens',),
        'draft_stats': ('forward_passes', 'proposed_tokens', 'accepted_tokens',
                        'zero_accept_batches'),
    }
    for group, keys in fields.items():
        for key in keys:
            group_value: object = result.get(group)
            group_fields: Mapping[str, object] = (cast(Mapping[str, object], group_value)
                                                  if isinstance(group_value, Mapping) else {})
            value: object = group_fields.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                span.set_attribute(f'zetacode.{group}.{key}', value)
