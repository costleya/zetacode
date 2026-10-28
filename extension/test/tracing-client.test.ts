import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { status } from "@grpc/grpc-js";
import { afterEach, expect, test } from "vite-plus/test";
import { CompletionClient } from "~/api/completion-client.ts";
import { deferred, final, firstToken, grpcServer } from "./fixtures/grpc-server.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function tracing() {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  cleanup.push(() => provider.shutdown());
  return { exporter, tracer: provider.getTracer("test") };
}
const request = {
  model: "zeta-2.1",
  prompt: "private source /secret/project.ts",
  temperature: 0,
  maxTokens: 2,
  stop: [],
  timeoutMs: 2000,
};

test("concurrent completion RPCs propagate their explicit parent without global context", async () => {
  const { exporter, tracer } = tracing();
  const received: string[] = [];
  const both = deferred();
  const server = await grpcServer((call) => {
    received.push(String(call.metadata.get("traceparent")[0]));
    if (received.length === 2) both.resolve();
    void both.promise.then(() => {
      firstToken(call);
      final(call, "private generated code");
    });
  });
  cleanup.push(server.close);
  const client = new CompletionClient(server.endpoint);
  cleanup.push(() => client.dispose());
  const roots = [
    tracer.startSpan("completion.a", {}, ROOT_CONTEXT),
    tracer.startSpan("completion.b", {}, ROOT_CONTEXT),
  ];
  await Promise.all(
    roots.map((root) =>
      client.complete({
        ...request,
        tracer,
        traceContext: trace.setSpan(ROOT_CONTEXT, root),
        onFirstToken() {},
      }),
    ),
  );
  roots.forEach((root) => root.end());
  const spans = exporter.getFinishedSpans();
  const rpc = spans.filter((span) => span.kind === SpanKind.CLIENT);
  expect(rpc).toHaveLength(2);
  for (const root of roots) {
    const span = rpc.find((item) => item.spanContext().traceId === root.spanContext().traceId)!;
    expect(span.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(received).toContain(`00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`);
    expect(span.events.map((event) => event.name)).toEqual(["first_token"]);
    expect(span.status.code).toBe(SpanStatusCode.OK);
  }
  expect(roots[0]!.spanContext().traceId).not.toBe(roots[1]!.spanContext().traceId);
  expect(
    JSON.stringify(
      spans.map((span) => ({
        attributes: span.attributes,
        events: span.events,
        status: span.status,
      })),
    ),
  ).not.toMatch(/private|secret|project\.ts/);
});

test.each(["abort", "error", "dispose", "deadline"] as const)(
  "%s ends the RPC span once without exporting raw error content",
  async (mode) => {
    const { exporter, tracer } = tracing();
    const entered = deferred();
    const server = await grpcServer((call) => {
      entered.resolve();
      if (mode === "error")
        call.emit(
          "error",
          Object.assign(new Error("private source /secret/project.ts"), { code: status.INTERNAL }),
        );
    });
    cleanup.push(server.close);
    const client = new CompletionClient(server.endpoint);
    cleanup.push(() => client.dispose());
    const controller = new AbortController();
    const pending = client.complete(
      { ...request, timeoutMs: mode === "deadline" ? 100 : request.timeoutMs, tracer },
      controller.signal,
    );
    const rejected = expect(pending).rejects.toThrow();
    await entered.promise;
    if (mode === "abort") controller.abort();
    if (mode === "dispose") client.dispose();
    await rejected;
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.kind).toBe(SpanKind.CLIENT);
    expect(spans[0]!.status.code).toBe(
      mode === "abort" ? SpanStatusCode.UNSET : SpanStatusCode.ERROR,
    );
    expect(spans[0]!.attributes["nesweep.outcome"]).toBe(mode === "abort" ? "cancelled" : "error");
    expect(
      JSON.stringify({
        attributes: spans[0]!.attributes,
        events: spans[0]!.events,
        status: spans[0]!.status,
      }),
    ).not.toMatch(/private|secret|project\.ts/);
  },
);

test("a request without an explicit tracer sends no traceparent and cannot inherit another request", async () => {
  const metadata: string[][] = [];
  const server = await grpcServer((call) => {
    metadata.push(call.metadata.get("traceparent").map(String));
    final(call);
  });
  cleanup.push(server.close);
  const client = new CompletionClient(server.endpoint);
  cleanup.push(() => client.dispose());
  const { tracer } = tracing();
  await client.complete({ ...request, tracer });
  await client.complete(request);
  expect(metadata[0]).toHaveLength(1);
  expect(metadata[1]).toEqual([]);
});
