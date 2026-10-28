"""Actual gRPC service and SDK, with CPU-only generation for wire tracing tests."""
import json
from pathlib import Path
import sys
import threading

root = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(root / 'server/tests'))
sys.path.insert(0, str(root / 'server/src'))
from test_server import load_server
import observability
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

exporter = InMemorySpanExporter()
provider = TracerProvider(resource=Resource.create({
    'service.namespace': 'nesweep', 'service.name': 'model-server'}))
provider.add_span_processor(SimpleSpanProcessor(exporter))
observability.configure_tracing(provider=provider)
module = load_server()
barrier = threading.Barrier(2, timeout=5)

class FakeDecoder:
    def generate(self, prompt, **options):
        # Both real service workers must be inside generation before either returns.
        barrier.wait()
        with observability.span_scope('decoder.prefill'):
            pass
        with observability.span_scope('decoder.decode'):
            if options.get('on_first_token'):
                options['on_first_token']()
        return {'text': 'private completion', 'finish_reason': 'stop',
                'usage': {'prompt_tokens': 7, 'completion_tokens': 2}}

service = module.CompletionService(FakeDecoder(), FakeDecoder())
server = module.create_server(sys.argv[1], service).start()
print(json.dumps({'ready': True}), flush=True)
try:
    sys.stdin.readline()
finally:
    server.stop(0)
    service.shutdown()
    provider.force_flush()
    rows = []
    for span in exporter.get_finished_spans():
        rows.append({'name': span.name, 'traceId': format(span.context.trace_id, '032x'),
                     'spanId': format(span.context.span_id, '016x'),
                     'parentSpanId': format(span.parent.span_id, '016x') if span.parent else None,
                     'kind': span.kind.name, 'attributes': dict(span.attributes),
                     'resource': dict(span.resource.attributes),
                     'events': [{'name': e.name, 'attributes': dict(e.attributes)} for e in span.events]})
    Path(sys.argv[2]).write_text(json.dumps(rows))
    observability.shutdown_tracing()
