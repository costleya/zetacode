import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { trace } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ExportResultCode } from "@opentelemetry/core";
import {
  SimpleSpanProcessor,
  TracerProvider,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace";

import { createTelemetry, ExtensionTelemetry } from "~/core/telemetry.ts";

const consoleDir = console.dir;

afterEach(() => {
  console.dir = consoleDir;
  vi.restoreAllMocks();
});

function inMemoryTelemetry() {
  const finishedSpans: ReadableSpan[] = [];
  const exporter: SpanExporter = {
    export(spans, callback) {
      finishedSpans.push(...spans);
      callback({ code: ExportResultCode.SUCCESS });
    },
    shutdown: () => Promise.resolve(),
  };
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ "service.namespace": "nesweep" }),
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  });
  return {
    exporter: { getFinishedSpans: () => finishedSpans },
    telemetry: new ExtensionTelemetry(provider),
  };
}

describe("ExtensionTelemetry", () => {
  test("keeps completion spans bounded to lifecycle data and closes them on shutdown", async () => {
    const { exporter, telemetry } = inMemoryTelemetry();
    const document = {
      version: 3,
      uri: "file:///private/secret.ts",
      text: "const privatePrompt = 'do not export';",
    };
    telemetry.recordDocumentChange(document);
    const span = telemetry.startCompletion(document);

    expect(span).toBeDefined();
    await telemetry.shutdown();

    const [completion] = exporter.getFinishedSpans();
    expect(completion?.name).toBe("nesweep.completion");
    expect(completion?.ended).toBe(true);
    expect(completion?.attributes).toMatchObject({
      "nesweep.outcome": "disposed",
      "nesweep.paint_observed": false,
    });
    expect(completion?.resource.attributes["service.namespace"]).toBe("nesweep");

    const exported = JSON.stringify({
      name: completion?.name,
      attributes: completion?.attributes,
      events: completion?.events,
      links: completion?.links,
    });
    expect(exported).not.toContain("file:///private/secret.ts");
    expect(exported).not.toContain("const privatePrompt =");
    const attributeNames = Object.keys(completion?.attributes ?? {});
    expect(attributeNames).not.toContain("document.uri");
    expect(attributeNames).not.toContain("file.path");
    expect(attributeNames).not.toContain("prompt");
    expect(attributeNames).not.toContain("exception.message");
  });

  test("records an explicit completion outcome once", async () => {
    const { exporter, telemetry } = inMemoryTelemetry();
    const span = telemetry.startCompletion({ version: 1 });

    telemetry.endCompletion(span, "no_edit");
    telemetry.endCompletion(span, "error");

    const completions = exporter.getFinishedSpans();
    expect(completions).toHaveLength(1);
    expect(completions[0]?.attributes["nesweep.outcome"]).toBe("no_edit");
    await telemetry.shutdown();
  });

  test("does not create an exporter by default or for OTLP without an endpoint", async () => {
    const disabled = createTelemetry({});
    const missingEndpoint = createTelemetry({ OTEL_TRACES_EXPORTER: "otlp" });

    expect(disabled.tracer).toBeUndefined();
    expect(disabled.startCompletion({ version: 1 })).toBeUndefined();
    expect(missingEndpoint.tracer).toBeUndefined();

    await Promise.all([disabled.shutdown(), missingEndpoint.shutdown()]);
  });

  test("writes spans to the console only when explicitly selected", async () => {
    const hostProvider = trace.getTracerProvider();
    const output = vi.fn();
    console.dir = output;
    const telemetry = createTelemetry({ OTEL_TRACES_EXPORTER: "console" });
    expect(trace.getTracerProvider()).toBe(hostProvider);
    const span = telemetry.startCompletion({ version: 1 });

    expect(span).toBeDefined();
    telemetry.endCompletion(span, "success");
    await telemetry.shutdown();

    expect(output).toHaveBeenCalled();
    expect(JSON.stringify(output.mock.calls)).toContain('"service.namespace":"nesweep"');
    expect(JSON.stringify(output.mock.calls)).toContain('"service.name":"vscode-extension"');
    expect(JSON.stringify(output.mock.calls)).toContain("nesweep.completion");
    expect(trace.getTracerProvider()).toBe(hostProvider);
  });
});
