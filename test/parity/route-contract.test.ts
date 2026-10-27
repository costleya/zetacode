import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import * as vscode from "vscode";

import { ApiClient, type AutocompleteInput } from "~/api/client.ts";
import type { CompletionRequest, CompletionResult } from "~/api/completion-client.ts";
import { MODEL_NAME } from "~/core/constants.ts";
import type { AutocompleteResult } from "~/api/schemas.ts";
import type { CompletionServer } from "~/services/completion-server.ts";
import { continuationDocument } from "../fixtures/continuation-document.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function configure(values: Record<string, unknown> = {}): void {
  (
    globalThis as typeof globalThis & { __vscodeMockConfiguration?: Record<string, unknown> }
  ).__vscodeMockConfiguration = {
    maxContextFiles: 0,
    outlineSymbols: 0,
    reuseIdenticalPromptResults: false,
    ...values,
  };
}

afterEach(() => {
  configure();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("completion route contract", () => {
  test("keeps speculative Qwen private on Zeta-first and returns the valid Zeta edit", async () => {
    vi.useFakeTimers();
    configure({ editableTokens: 1 });
    const { document } = continuationDocument("function demo() {\n  old();\n}");
    const position = new vscode.Position(1, 2);
    const input: AutocompleteInput = {
      document,
      position,
      originalContent: document.getText(),
      recentChanges: [],
      recentBuffers: [],
      diagnostics: [],
      userActions: [
        {
          action_type: "DELETE_CHAR",
          line_number: position.line,
          offset: document.offsetAt(position),
          file_path: document.fileName,
          timestamp: 1,
        },
      ],
      canUseContinuationFallback: () => true,
    };
    const zetaStarted = deferred<CompletionRequest>();
    const qwenStarted = deferred<void>();
    const zeta = deferred<CompletionResult>();
    const qwen = deferred<CompletionResult>();
    const complete = vi.fn((request: CompletionRequest) => {
      if (request.model === MODEL_NAME) {
        zetaStarted.resolve(request);
        return zeta.promise;
      }
      qwenStarted.resolve();
      return qwen.promise;
    });
    const server = {
      waitUntilReady: async () => {},
      getClient: () => ({ complete }),
      reportSuccess: vi.fn(),
      reportFailure: vi.fn(),
    };
    const client = new ApiClient(server as unknown as CompletionServer);
    vi.spyOn(client, "getDebugInfo").mockReturnValue("test");
    const publishIntermediate = vi.fn<(results: AutocompleteResult[]) => void>();
    input.onIntermediateResults = publishIntermediate;

    const response = client.getAutocomplete(input);
    const zetaRequest = await zetaStarted.promise;
    expect(publishIntermediate).not.toHaveBeenCalled();
    expect(zetaRequest.onFirstToken).toBeTypeOf("function");

    zetaRequest.onFirstToken?.();
    await vi.advanceTimersByTimeAsync(80);
    await qwenStarted.promise;
    qwen.resolve({ text: "replacement", finishReason: "stop" });
    await vi.advanceTimersByTimeAsync(0);

    expect(publishIntermediate).not.toHaveBeenCalled();
    zeta.resolve({
      text: "<|marker_1|>  replacement();\n<|marker_2|>",
      finishReason: "stop",
    });
    const results = await response;

    expect(results).toHaveLength(1);
    const edit = results?.[0];
    expect(edit).toBeDefined();
    const updated =
      document.getText().slice(0, edit!.startIndex) +
      edit!.completion +
      document.getText().slice(edit!.endIndex);
    expect(updated).toBe("function demo() {\n  replacement();\n}");
    expect(results?.[0]?.source).not.toBe("continuation");
    expect(publishIntermediate).not.toHaveBeenCalled();
  });

  test("passes Python inline diagnostics to Zeta with a hash comment prefix", async () => {
    configure({ injectInlineDiagnostics: true, inlineDiagnosticsMarker: "PY_DIAGNOSTIC" });
    const { document: baseDocument } = continuationDocument("value = old");
    const document = Object.assign(baseDocument, { languageId: "python" });
    const position = new vscode.Position(0, "value = ".length);
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(new vscode.Position(0, 8), new vscode.Position(0, 11)),
      "Expected an integer",
      vscode.DiagnosticSeverity.Error,
    );
    const input: AutocompleteInput = {
      document,
      position,
      originalContent: document.getText(),
      recentChanges: [],
      recentBuffers: [],
      diagnostics: [diagnostic],
      userActions: [],
    };
    const requests: CompletionRequest[] = [];
    const complete = vi.fn((request: CompletionRequest) => {
      requests.push(request);
      return Promise.resolve({ text: "<|marker_1|><|marker_1|>", finishReason: "stop" });
    });
    const server = {
      waitUntilReady: async () => {},
      getClient: () => ({ complete }),
      reportSuccess: vi.fn(),
      reportFailure: vi.fn(),
    };
    const client = new ApiClient(server as unknown as CompletionServer);
    vi.spyOn(client, "getDebugInfo").mockReturnValue("test");

    await client.getAutocomplete(input);

    expect(complete).toHaveBeenCalledOnce();
    expect(requests[0]?.prompt).toContain("# PY_DIAGNOSTIC (error): Expected an integer");
    expect(requests[0]?.prompt).not.toContain("// PY_DIAGNOSTIC");
  });
});
