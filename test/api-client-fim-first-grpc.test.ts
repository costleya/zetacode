import { afterEach, expect, test, vi } from "vite-plus/test";
import * as vscode from "vscode";
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
    userActions: [],
    canUseContinuationFallback: () => true,
  };
  return { client, input, server };
}
const edit = "<|marker_1|>\nfunction demo() {\n  return 1;\n}\n<|marker_2|>";

test("real gRPC completes and publishes FIM before dispatching primary", async () => {
  const fallbackStarted = deferred();
  const primaryStarted = deferred();
  const published = deferred();
  let primary: CompletionCall | undefined;
  let fim: CompletionCall | undefined;
  const { client, input, server } = await setup((call) => {
    if (call.request.model === "zeta-2.1") {
      primary = call;
      primaryStarted.resolve();
      return;
    }
    expect(call.request.model).toBe("qwen2.5-coder-7b-instruct");
    expect(call.request.prompt).toContain("<|fim_prefix|>");
    expect(call.request.repeatPenalty).toBe(1.1);
    expect(primary).toBeUndefined();
    fim = call;
    fallbackStarted.resolve();
  });
  const failure = vi.spyOn(server, "reportFailure");
  input.onIntermediateResults = (results) => {
    expect(results[0]?.completion).toBe("return 42;");
    expect(primary).toBeUndefined();
    published.resolve();
  };
  const pending = client.getAutocomplete(input);
  await fallbackStarted.promise;
  expect(primary).toBeUndefined();
  final(fim!, "return 42;");
  await published.promise;
  await primaryStarted.promise;
  final(primary!, "<|marker_1|><|marker_1|>");
  expect((await pending)?.[0]?.completion).toBe("return 42;");
  expect(failure).not.toHaveBeenCalled();
});

test("later no-edit-impossible preserves the already published FIM candidate", async () => {
  const started = deferred();
  const primaryStarted = deferred();
  const published = deferred();
  let primary: CompletionCall | undefined;
  let fim: CompletionCall | undefined;
  const { client, input } = await setup((call) => {
    if (call.request.model === "zeta-2.1") {
      primary = call;
      primaryStarted.resolve();
      firstToken(call);
      return;
    }
    fim = call;
    started.resolve();
  });
  input.onIntermediateResults = () => published.resolve();
  const pending = client.getAutocomplete(input);
  await started.promise;
  expect(primary).toBeUndefined();
  final(fim!, "return 42;");
  await published.promise;
  await primaryStarted.promise;
  noEditImpossible(primary!);
  expect(primary!.cancelled).toBe(false);
  final(primary!, edit);
  expect((await pending)?.[0]?.completion).toBe("return 42;");
});

test.each(["FIM", "Zeta"] as const)(
  "parent cancellation during %s aborts the active stream without starting extra work",
  async (phase) => {
    const primaryStarted = deferred();
    const fimStarted = deferred();
    const cancelled = deferred();
    const models: string[] = [];
    let fim: CompletionCall | undefined;
    const { client, input, server } = await setup((call) => {
      models.push(call.request.model);
      if (call.request.model === "zeta-2.1") {
        call.on("cancelled", () => cancelled.resolve());
        primaryStarted.resolve();
      } else {
        fim = call;
        if (phase === "FIM") call.on("cancelled", () => cancelled.resolve());
        fimStarted.resolve();
      }
    });
    const failure = vi.spyOn(server, "reportFailure");
    const controller = new AbortController();
    const pending = client.getAutocomplete(input, controller.signal);
    await fimStarted.promise;
    expect(models).toEqual(["qwen2.5-coder-7b-instruct"]);
    if (phase === "Zeta") {
      final(fim!, "return 42;");
      await primaryStarted.promise;
    }
    controller.abort();
    await cancelled.promise;
    expect(await pending).toBeNull();
    expect(models).toEqual(
      phase === "FIM" ? ["qwen2.5-coder-7b-instruct"] : ["qwen2.5-coder-7b-instruct", "zeta-2.1"],
    );
    expect(failure).not.toHaveBeenCalled();
  },
);

test("a usable Zeta edit in existing code suppresses FIM", async () => {
  const models: string[] = [];
  const { client, input } = await setup((call) => {
    models.push(call.request.model);
    final(call, edit);
  });
  input.position = new vscode.Position(0, "function de".length);
  expect((await client.getAutocomplete(input))?.[0]?.completion).toContain("return 1;");
  expect(models).toEqual(["zeta-2.1"]);
});

test("a Qwen RPC error does not poison primary edit health", async () => {
  const started = deferred();
  const primaryStarted = deferred();
  let primary: CompletionCall | undefined;
  const { client, input, server } = await setup((call) => {
    if (call.request.model === "zeta-2.1") {
      primary = call;
      primaryStarted.resolve();
      firstToken(call);
      return;
    }
    expect(primary).toBeUndefined();
    call.emit("error", new Error("Qwen unavailable"));
    started.resolve();
  });
  const failure = vi.spyOn(server, "reportFailure");
  const pending = client.getAutocomplete(input);
  await Promise.all([started.promise, primaryStarted.promise]);
  final(primary!, edit);
  expect((await pending)?.[0]?.completion).toBe("return 1;");
  expect(failure).not.toHaveBeenCalled();
});
