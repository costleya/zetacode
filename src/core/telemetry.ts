import {
  SpanStatusCode,
  ROOT_CONTEXT,
  type Span,
  type Tracer,
  type TracerProvider,
} from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  TracerProvider as SDKTracerProvider,
} from "@opentelemetry/sdk-trace";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";

interface DocumentBookmark {
  version: number;
  time: number;
}
type OwnedProvider = TracerProvider & {
  forceFlush(options?: { timeoutMillis?: number }): Promise<void>;
  shutdown(): Promise<void>;
};

/** Private to this extension: never registers with the shared extension host. */
export class ExtensionTelemetry {
  readonly tracer: Tracer | undefined;
  private readonly changes = new WeakMap<object, DocumentBookmark>();
  private readonly roots = new Set<Span>();
  private closing: Promise<void> | undefined;

  constructor(private readonly provider?: OwnedProvider) {
    this.tracer = provider?.getTracer("nesweep");
  }

  recordDocumentChange(document: object & { version: number }): void {
    if (this.tracer && !this.closing)
      this.changes.set(document, { version: document.version, time: Date.now() });
  }

  startCompletion(document: object & { version: number }): Span | undefined {
    if (!this.tracer || this.closing) return undefined;
    const bookmark = this.changes.get(document);
    this.changes.delete(document);
    const span = this.tracer.startSpan(
      "nesweep.completion",
      {
        ...(bookmark?.version === document.version ? { startTime: bookmark.time } : {}),
        attributes: { "nesweep.paint_observed": false },
      },
      ROOT_CONTEXT,
    );
    this.roots.add(span);
    return span;
  }

  endCompletion(span: Span | undefined, outcome: string): void {
    if (!span || !this.roots.delete(span)) return;
    span.setAttribute("nesweep.outcome", outcome);
    if (outcome === "error" || outcome === "decoration_error")
      span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
  }

  shutdown(): Promise<void> {
    return (this.closing ??= (async () => {
      for (const root of this.roots) this.endCompletion(root, "disposed");
      try {
        await this.provider?.forceFlush({ timeoutMillis: 1000 });
      } finally {
        await this.provider?.shutdown();
      }
    })());
  }
}

/** Standard exporters only; no implicit localhost network destination. */
export function createTelemetry(env: NodeJS.ProcessEnv = process.env): ExtensionTelemetry {
  const selected = env["OTEL_TRACES_EXPORTER"] ?? "none";
  const endpoint = env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] || env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  const protocol =
    env["OTEL_EXPORTER_OTLP_TRACES_PROTOCOL"] ||
    env["OTEL_EXPORTER_OTLP_PROTOCOL"] ||
    "http/protobuf";
  try {
    const exporter =
      selected === "console"
        ? new ConsoleSpanExporter()
        : selected === "otlp" && endpoint && protocol === "http/protobuf"
          ? new OTLPTraceExporter({
              url:
                env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] ||
                `${endpoint!.replace(/\/$/, "")}/v1/traces`,
            })
          : undefined;
    if (!exporter) return new ExtensionTelemetry();
    return new ExtensionTelemetry(
      new SDKTracerProvider({
        resource: resourceFromAttributes({
          "service.namespace": "nesweep",
          "service.name": "vscode-extension",
        }),
        spanProcessors: [new BatchSpanProcessor({ exporter, exportTimeoutMillis: 1000 })],
      }),
    );
  } catch {
    return new ExtensionTelemetry();
  }
}
