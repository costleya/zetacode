import { afterEach, expect, test, vi } from "vite-plus/test";
import * as vscode from "vscode";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { status } from "@grpc/grpc-js";
import { ApiClient, type AutocompleteInput } from "~/api/client.ts";
import { CompletionServer } from "~/services/completion-server.ts";
import { continuationDocument } from "./fixtures/continuation-document.ts";
import {
  deferred,
  final,
  firstToken,
  grpcServer,
  noEditImpossible,
  type CompletionCall,
} from "./fixtures/grpc-server.ts";

const resources: Array<{ dispose(): void } | { close(): Promise<void> }> = [];
afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) {
    if ("dispose" in resource) resource.dispose();
    else await resource.close();
  }
  vi.restoreAllMocks();
});
async function setup(handler: (call: CompletionCall) => void) {
  (
    globalThis as typeof globalThis & { __vscodeMockConfiguration?: Record<string, unknown> }
  ).__vscodeMockConfiguration = {
    maxContextFiles: 0,
    outlineSymbols: 0,
    reuseIdenticalPromptResults: false,
  };
  const transport = await grpcServer(handler);
  resources.push(transport);
  const server = new CompletionServer(transport.endpoint.socketPath);
  resources.push(server);
  const client = new ApiClient(server);
  vi.spyOn(client, "getDebugInfo").mockReturnValue("gRPC integration");
  const { document } = continuationDocument();
  const input: AutocompleteInput = {
    document,
    position: new vscode.Position(1, 2),
    originalContent: document.getText(),
    recentChanges: [],
    recentBuffers: [],
    diagnostics: [],
    // Preserve the existing optimized Zeta-first fallback scenarios.
    userActions: [
      {
        action_type: "DELETE_CHAR",
        line_number: 1,
        offset: 2,
        file_path: document.fileName,
        timestamp: 1,
      },
    ],
    canUseContinuationFallback: () => true,
  };
  return { client, input, server };
}
const edit = "<|marker_1|>\nfunction demo() {\n  return 1;\n}\n<|marker_2|>";

test("a real gRPC first token launches Qwen before final primary no-edit", async () => {
  const fallbackStarted = deferred();
  let primary: CompletionCall | undefined;
  const { client, input, server } = await setup((call) => {
    if (call.request.model === "zeta-2.1") {
      primary = call;
      firstToken(call);
      return;
    }
    expect(call.request.model).toBe("qwen2.5-coder-7b-instruct");
    expect(call.request.prompt).toContain("<|fim_prefix|>");
    expect(call.request.repeatPenalty).toBe(1.1);
    expect(primary).toBeDefined();
    fallbackStarted.resolve();
    final(call, "return 42;");
  });
  const failure = vi.spyOn(server, "reportFailure");
  const pending = client.getAutocomplete(input);
  await fallbackStarted.promise;
  final(primary!, "<|marker_1|><|marker_1|>");
  expect((await pending)?.[0]?.completion).toBe("return 42;");
  expect(failure).not.toHaveBeenCalled();
});

test("no-edit-impossible cancels Qwen alone and leaves primary stream usable", async () => {
  const started = deferred();
  const cancelled = deferred();
  let primary: CompletionCall | undefined;
  const { client, input } = await setup((call) => {
    if (call.request.model === "zeta-2.1") {
      primary = call;
      firstToken(call);
      return;
    }
    call.on("cancelled", () => cancelled.resolve());
    started.resolve();
  });
  const pending = client.getAutocomplete(input);
  await started.promise;
  noEditImpossible(primary!);
  await cancelled.promise;
  expect(primary!.cancelled).toBe(false);
  final(primary!, edit);
  expect((await pending)?.[0]?.completion).toBe("return 1;");
});

test("a Qwen RPC error does not poison primary edit health", async () => {
  const started = deferred();
  let primary: CompletionCall | undefined;
  const { client, input, server } = await setup((call) => {
    if (call.request.model === "zeta-2.1") {
      primary = call;
      firstToken(call);
      return;
    }
    call.emit("error", new Error("Qwen unavailable"));
    started.resolve();
  });
  const failure = vi.spyOn(server, "reportFailure");
  const pending = client.getAutocomplete(input);
  await started.promise;
  final(primary!, edit);
  expect((await pending)?.[0]?.completion).toBe("return 1;");
  expect(failure).not.toHaveBeenCalled();
});

test.each(["transport error", "deadline"] as const)(
  "a primary %s keeps the functional null result and records the API failure",
  async (failure) => {
    const { client, input } = await setup((call) => {
      if (failure === "transport error")
        call.emit(
          "error",
          Object.assign(new Error("private transport error /secret/model"), {
            code: status.INTERNAL,
          }),
        );
    });
    (
      globalThis as typeof globalThis & { __vscodeMockConfiguration?: Record<string, unknown> }
    ).__vscodeMockConfiguration = {
      maxContextFiles: 0,
      outlineSymbols: 0,
      reuseIdenticalPromptResults: false,
      completionTimeoutMs: failure === "deadline" ? 100 : 2000,
    };
    const exporter = new InMemorySpanExporter();
    const sdk = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
    try {
      const result = await client.getAutocomplete({
        ...input,
        canUseContinuationFallback: () => false,
        tracer: sdk.getTracer("api-failure-test"),
      });
      expect(result).toBeNull();
      const spans = exporter.getFinishedSpans();
      const api = spans.filter((span) => span.name === "nesweep.api.autocomplete");
      expect(api).toHaveLength(1);
      expect(api[0]!.ended).toBe(true);
      expect(api[0]!.attributes["nesweep.outcome"]).toBe("error");
      expect(api[0]!.status.code).toBe(SpanStatusCode.ERROR);
      expect(
        JSON.stringify(
          spans.map(({ attributes, events, status }) => ({ attributes, events, status })),
        ),
      ).not.toMatch(/private transport error|secret\/model/);
    } finally {
      await sdk.shutdown();
    }
  },
);
