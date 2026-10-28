/** Real cross-language tracing, no MLX model required.
 * node --experimental-transform-types --import ./test/production-register.mjs test/otel-grpc-python.integration.ts [python]
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { ROOT_CONTEXT, SpanKind, trace } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { CompletionClient } from "../src/api/completion-client.ts";

type PythonSpan = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  kind: string;
  attributes: Record<string, unknown>;
  resource: Record<string, unknown>;
  events: unknown[];
};
const directory = await mkdtemp("/tmp/nes-otel-wire-");
const socketPath = join(directory, "service.sock");
const output = join(directory, "spans.json");
const child = spawn(
  process.argv[2] ?? "../server/.venv/bin/python",
  ["test/fixtures/otel-python-service.py", socketPath, output],
  { stdio: ["pipe", "pipe", "pipe"] },
);
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});
const exited = once(child, "exit");
const lines = createInterface({ input: child.stdout });
const client = new CompletionClient({ socketPath });
const exporter = new InMemorySpanExporter();
const provider = new TracerProvider({
  resource: resourceFromAttributes({
    "service.namespace": "nesweep",
    "service.name": "vscode-extension",
  }),
  spanProcessors: [new SimpleSpanProcessor({ exporter })],
});
const tracer = provider.getTracer("nesweep.integration");
let stopped = false;
async function stop() {
  if (stopped) return;
  stopped = true;
  child.stdin.end("stop\n");
  const [code] = await exited;
  assert.equal(code, 0, stderr);
}
try {
  const ready = await Promise.race([
    once(lines, "line").then(([line]) => JSON.parse(String(line))),
    exited.then(() => {
      throw new Error(`Python fixture exited before ready: ${stderr}`);
    }),
  ]);
  assert.equal(ready.ready, true);
  const roots = [
    tracer.startSpan("nesweep.completion", {}, ROOT_CONTEXT),
    tracer.startSpan("nesweep.completion", {}, ROOT_CONTEXT),
  ];
  try {
    const results = await Promise.all(
      roots.map((root, index) =>
        client.complete({
          model: index === 0 ? "zeta-2.1" : "qwen2.5-coder-7b-instruct",
          repeatPenalty: index === 0 ? 1 : 1.1,
          prompt: `private source ${index} /secret/project.ts`,
          temperature: 0,
          maxTokens: 2,
          stop: [],
          timeoutMs: 5000,
          tracer,
          traceContext: trace.setSpan(ROOT_CONTEXT, root),
        }),
      ),
    );
    assert.deepEqual(
      results.map((result) => result.text),
      ["private completion", "private completion"],
    );
  } finally {
    roots.forEach((root) => root.end());
  }
  await provider.forceFlush();
  await stop();
  const python: PythonSpan[] = JSON.parse(await readFile(output, "utf8"));
  const node = exporter.getFinishedSpans();
  assert.notEqual(roots[0]!.spanContext().traceId, roots[1]!.spanContext().traceId);
  assert.equal(python.length, 8, "each RPC ends server, generation, prefill and decode spans");
  for (const root of roots) {
    const traceId = root.spanContext().traceId;
    const rpc = node.filter(
      (span) => span.kind === SpanKind.CLIENT && span.spanContext().traceId === traceId,
    );
    assert.equal(rpc.length, 1);
    assert.equal(rpc[0]!.parentSpanContext?.spanId, root.spanContext().spanId);
    const remote = python.filter((span) => span.traceId === traceId);
    assert.equal(
      remote.length,
      4,
      "worker model spans retain the RPC trace through thread handoff",
    );
    const server = remote.find((span) => span.kind === "SERVER")!;
    assert.ok(server);
    assert.equal(
      server.parentSpanId,
      rpc[0]!.spanContext().spanId,
      "W3C metadata uses the client span as the remote parent",
    );
    const generation = remote.find((span) => span.name === "completion.generate")!;
    assert.ok(generation);
    assert.equal(generation.parentSpanId, server.spanId);
    for (const name of ["decoder.prefill", "decoder.decode"]) {
      const phase = remote.find((span) => span.name === name)!;
      assert.ok(phase);
      assert.equal(phase.parentSpanId, generation.spanId);
    }
    for (const span of remote) {
      assert.equal(span.resource["service.namespace"], "nesweep");
      assert.equal(span.resource["service.name"], "model-server");
    }
    assert.equal(rpc[0]!.resource.attributes["service.namespace"], "nesweep");
    assert.equal(rpc[0]!.resource.attributes["service.name"], "vscode-extension");
  }
  const exported = JSON.stringify([
    ...python.map(({ attributes, events }) => ({ attributes, events })),
    ...node.map(({ attributes, events, status }) => ({ attributes, events, status })),
  ]);
  assert.doesNotMatch(exported, /private source|private completion|secret|project\.ts/);
  console.log(
    "OpenTelemetry Node/Python production gRPC: concurrent isolated roots -> CLIENT -> SERVER -> worker generation -> prefill/decode, resource identity and privacy passed",
  );
} finally {
  client.dispose();
  lines.close();
  try {
    await stop();
  } finally {
    await provider.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
}
