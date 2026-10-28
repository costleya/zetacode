import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import * as vscode from "vscode";

import { ApiClient, type AutocompleteInput } from "~/api/client.ts";
import type { CompletionRequest, CompletionResult } from "~/api/completion-client.ts";
import { MODEL_NAME } from "~/core/constants.ts";
import type { AutocompleteResult } from "~/api/schemas.ts";
import { classifyCompletionRoute } from "~/api/completion-routing.ts";
import type { CompletionServer } from "~/services/completion-server.ts";
import { continuationDocument } from "./fixtures/continuation-document.ts";

function configure(values: Record<string, unknown> = {}) {
  (
    globalThis as typeof globalThis & { __vscodeMockConfiguration?: Record<string, unknown> }
  ).__vscodeMockConfiguration = {
    maxContextFiles: 0,
    outlineSymbols: 0,
    reuseIdenticalPromptResults: false,
    ...values,
  };
}

const noEdit: CompletionResult = { text: "<|marker_1|><|marker_1|>", finishReason: "stop" };
const zetaEdit: CompletionResult = {
  text: "<|marker_1|>\nfunction demo() {\n  return 1;\n}\n<|marker_2|>",
  finishReason: "stop",
};
const continuation: CompletionResult = { text: "return 42;", finishReason: "stop" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(text?: string) {
  vi.useFakeTimers();
  configure();
  const fixture = continuationDocument(text);
  const primary = vi.fn<() => Promise<CompletionResult>>().mockResolvedValue(noEdit);
  const fallback = vi
    .fn<(request: CompletionRequest, signal?: AbortSignal) => Promise<CompletionResult>>()
    .mockResolvedValue(continuation);
  const started = deferred<void>();
  const primaryStarted = deferred<void>();
  const complete = vi.fn((request: CompletionRequest, signal?: AbortSignal) => {
    if (request.model === MODEL_NAME) {
      primaryStarted.resolve();
      return primary();
    }
    started.resolve();
    return fallback(request, signal);
  });
  const server = {
    waitUntilReady: async () => {},
    getClient: () => ({ complete }),
    reportSuccess: vi.fn(),
    reportFailure: vi.fn(),
  };
  const client = new ApiClient(server as unknown as CompletionServer);
  vi.spyOn(client, "getDebugInfo").mockReturnValue("test");
  const input: AutocompleteInput = {
    document: fixture.document,
    position: new vscode.Position(1, 2),
    originalContent: fixture.document.getText(),
    recentChanges: [],
    recentBuffers: [],
    diagnostics: [],
    userActions: [],
    canUseContinuationFallback: () => true,
  };
  const fallbackSignal = () =>
    complete.mock.calls.find(([request]) => request.model !== MODEL_NAME)?.[1];
  return {
    ...fixture,
    client,
    input,
    complete,
    primary,
    fallback,
    started,
    primaryStarted,
    server,
    fallbackSignal,
  };
}

afterEach(() => {
  configure();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function atCursor(marked: string) {
  const offset = marked.indexOf("¦");
  const fixture = setup(marked.replace("¦", ""));
  fixture.input.position = fixture.document.positionAt(offset);
  return fixture;
}

function zetaDocument(text: string): CompletionResult {
  return { text: `<|marker_1|>\n${text}\n<|marker_2|>`, finishReason: "stop" };
}

describe("completion routing", () => {
  test.each([
    "const answer = ¦;",
    "const answer = Math.ma¦;",
    "console.log(¦);",
    "function demo() {\n  ¦\n}",
    "function demo() {\n  if (ready) {\n    ¦\n  }\n}",
    "function demo() {\n  return ¦;\n}",
  ])("routes an unfinished insertion to FIM first: %s", (marked) => {
    const { input } = atCursor(marked);
    expect(classifyCompletionRoute(input)).toBe("fim-first");
  });

  test.each([
    "const answer = ol¦dValue;",
    "function demo() {\n  ¦existing();\n}",
    "const answer = 42;¦",
    "// explain ¦this",
    "// const answer = ¦",
    "const label = 'hello ¦",
    "const label = 'hel¦lo';",
    "¦function existing() {}",
    "function demo() {\n  existing();\n  ¦\n}",
  ])("keeps existing-code or unknown contexts on Zeta only: %s", (marked) => {
    const { input } = atCursor(marked);
    expect(classifyCompletionRoute(input)).toBe("zeta-first");
  });

  test.each([
    "@@ -1 +1 @@\n-function demo(oldName) {\n+function demo(newName) {",
    "@@ -1 +1 @@\n-  oldField: string;\n+  newField: string;",
  ])("keeps related parameter or field changes on Zeta only", (diff) => {
    const { input } = atCursor("function demo(newName) {\n  ¦\n}");
    input.recentChanges = [{ path: input.document.uri.fsPath, diff }];
    expect(classifyCompletionRoute(input)).toBe("zeta-first");
  });
  test.each(["DELETE_CHAR", "UNDO", "REDO"] as const)(
    "keeps %s intent with Zeta",
    (action_type) => {
      const { input } = atCursor("const answer = ¦;");
      input.userActions = [
        {
          action_type,
          line_number: 0,
          offset: input.document.offsetAt(input.position),
          file_path: input.document.fileName,
          timestamp: 1,
        },
      ];
      expect(classifyCompletionRoute(input)).toBe("zeta-first");
    },
  );

  test("allows a contiguous insertion ending at the cursor", () => {
    const { input } = atCursor("const answer = Math.ma¦;");
    input.originalContent = "const answer = ;";
    expect(classifyCompletionRoute(input)).toBe("fim-first");
  });

  test.each([
    {
      name: "a typed character in an unfinished expression",
      marked: "const answer = Math.ma¦;",
      diff: "@@ -1 +1 @@\n-const answer = Math.m;\n+const answer = Math.ma;",
      route: "fim-first",
    },
    {
      name: "replacement of an existing expression",
      marked: "const answer = Math.max¦;",
      diff: "@@ -1 +1 @@\n-const answer = Math.min;\n+const answer = Math.max;",
      route: "zeta-first",
    },
    {
      name: "a newly added function parameter",
      marked: "function demo(arg) {\n  ¦\n}",
      diff: "@@ -1 +1 @@\n-function demo() {\n+function demo(arg) {",
      route: "zeta-first",
    },
  ])("uses actual tracker diff syntax for $name", ({ marked, diff, route }) => {
    const { input } = atCursor(marked);
    // The tracker can already have committed the current document baseline.
    // Intent must still be recoverable from its line-based recent change.
    input.recentChanges = [{ path: input.document.fileName, diff }];
    expect(classifyCompletionRoute(input)).toBe(route);
  });

  test.each([
    {
      name: "increment insertion",
      marked: "++counte¦;",
      old: "++count",
      next: "++counte",
      route: "fim-first",
    },
    {
      name: "decrement insertion",
      marked: "--counte¦;",
      old: "--count",
      next: "--counte",
      route: "fim-first",
    },
    {
      name: "increment replacement",
      marked: "++countex¦;",
      old: "++counter",
      next: "++countex",
      route: "zeta-first",
    },
    {
      name: "decrement replacement",
      marked: "--countex¦;",
      old: "--counter",
      next: "--countex",
      route: "zeta-first",
    },
  ])("classifies hunk-only tracker patches containing $name", ({ marked, old, next, route }) => {
    const { input } = atCursor(marked);
    input.recentChanges = [
      {
        path: input.document.fileName,
        diff: `@@ -1 +1 @@\n-${old};\n+${next};`,
      },
    ];
    expect(classifyCompletionRoute(input)).toBe(route);
  });

  test.each([
    { old: "++count", next: "++counte", route: "fim-first" },
    { old: "--counter", next: "--countex", route: "zeta-first" },
  ])("ignores file headers while classifying a unified patch", ({ old, next, route }) => {
    const { input } = atCursor(`${next}¦;`);
    input.recentChanges = [
      {
        path: input.document.fileName,
        diff: `--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-${old};\n+${next};`,
      },
    ];
    expect(classifyCompletionRoute(input)).toBe(route);
  });

  test.each([
    "@@ -1,2 +1,2 @@\n-const answer = Math.m;\n+const answer = Math.ma;",
    "@@ -1 +1 @@\n-const answer = Math.m;\n+const answer = Math.ma;\n...[truncated]",
    "@@ malformed @@\n-const answer = Math.m;\n+const answer = Math.ma;",
  ])("keeps malformed or truncated tracker patches on Zeta", (diff) => {
    const { input } = atCursor("const answer = Math.ma¦;");
    input.recentChanges = [{ path: input.document.fileName, diff }];
    expect(classifyCompletionRoute(input)).toBe("zeta-first");
  });

  test("keeps a patch missing its declared removed line on Zeta", () => {
    const { input } = atCursor("function demo() {\n  return ¦\n}");
    input.recentChanges = [{ path: input.document.fileName, diff: "@@ -1,1 +1,1 @@\n+ " }];
    expect(classifyCompletionRoute(input)).toBe("zeta-first");
  });

  test("routes a fresh insertion after unrelated edits since the file-open baseline to FIM", () => {
    const { input } = atCursor('const label = "new";\nconst answer = Math.ma¦;');
    input.originalContent = 'const label = "old";\nconst answer = Math.m;';
    input.recentChanges = [
      {
        path: input.document.fileName,
        diff: "@@ -2 +2 @@\n-const answer = Math.m;\n+const answer = Math.ma;",
      },
    ];
    expect(classifyCompletionRoute(input)).toBe("fim-first");
  });

  test("uses the freshest current-file insertion before older rewrites in newest-first history", () => {
    const { input } = atCursor("const newName = 1;\nconst answer = Math.ma¦;");
    input.recentChanges = [
      { path: "/workspace/other.ts", diff: "@@ -1 +1 @@\n-old();\n+newer();" },
      {
        path: input.document.fileName,
        diff: "@@ -2 +2 @@\n-const answer = Math.m;\n+const answer = Math.ma;",
      },
      {
        path: input.document.fileName,
        diff: "@@ -1 +1 @@\n-const oldName = 1;\n+const newName = 1;",
      },
    ];
    expect(classifyCompletionRoute(input)).toBe("fim-first");
  });

  test("keeps the freshest rewrite on Zeta despite an older insertion in newest-first history", () => {
    const { input } = atCursor("const answer = Math.ma¦;");
    input.recentChanges = [
      {
        path: input.document.fileName,
        diff: "@@ -1 +1 @@\n-const answer = Math.mi;\n+const answer = Math.ma;",
      },
      {
        path: input.document.fileName,
        diff: "@@ -1 +1 @@\n-const answer = Math.m;\n+const answer = Math.mi;",
      },
    ];
    expect(classifyCompletionRoute(input)).toBe("zeta-first");
  });

  test("keeps net replacement of an existing expression on Zeta", () => {
    const { input } = atCursor("const answer = Math.ma¦;");
    input.originalContent = "const answer = previousValue;";
    expect(classifyCompletionRoute(input)).toBe("zeta-first");
  });
});

describe("ApiClient route-specific forward typing", () => {
  test.each(["zeta-first", "fim-first"] as const)(
    "preserves original-snapshot primary edits only for %s",
    async (route) => {
      const { client, input, primary, primaryStarted, fallback, update } = setup();
      if (route === "zeta-first")
        input.userActions = [
          {
            action_type: "DELETE_CHAR",
            line_number: 1,
            offset: 2,
            file_path: input.document.fileName,
            timestamp: 1,
          },
        ];
      const zeta = deferred<CompletionResult>();
      primary.mockReturnValue(zeta.promise);
      let eligible = true;
      input.canUseContinuationFallback = () => eligible;
      const original = input.document.getText();
      const offset = input.document.offsetAt(input.position);
      const response = client.getAutocomplete(input);
      await primaryStarted.promise;
      update(original.slice(0, offset) + "ret" + original.slice(offset));
      eligible = false;
      zeta.resolve(zetaEdit);
      const results = await response;
      if (route === "zeta-first") {
        expect(results).toHaveLength(1);
        const result = results![0]!;
        expect(result.completion).toBe("return 1;");
        expect(
          original.slice(0, result.startIndex) +
            result.completion +
            original.slice(result.endIndex),
        ).toBe("function demo() {\n  return 1;\n}");
        expect(fallback).not.toHaveBeenCalled();
      } else {
        expect(results).toBeNull();
        expect(fallback).toHaveBeenCalledOnce();
      }
    },
  );
});

describe("ApiClient FIM-first completion", () => {
  test.each([undefined, false])(
    "publishes completed FIM before a pending Zeta with legacy setting %j",
    async (legacySetting) => {
      const { client, input, primary, fallback, started, primaryStarted, complete } = setup();
      configure(legacySetting === undefined ? {} : { continuationFallbackEnabled: legacySetting });
      const zeta = deferred<CompletionResult>();
      const fim = deferred<CompletionResult>();
      primary.mockReturnValue(zeta.promise);
      fallback.mockReturnValue(fim.promise);
      const published = deferred<AutocompleteResult[]>();
      const onIntermediateResults = vi.fn((results: AutocompleteResult[]) =>
        published.resolve(results),
      );
      input.onIntermediateResults = onIntermediateResults;
      const response = client.getAutocomplete(input);
      await started.promise;
      // Zeta cannot contend with FIM while its generation is pending.
      expect(primary).not.toHaveBeenCalled();
      expect(fallback).toHaveBeenCalledOnce();
      expect(complete).toHaveBeenCalledTimes(1);
      expect(onIntermediateResults).not.toHaveBeenCalled();
      fim.resolve(continuation);
      expect((await published.promise)[0]?.completion).toBe("return 42;");
      expect(onIntermediateResults).toHaveBeenCalledOnce();
      await primaryStarted.promise;
      expect(complete).toHaveBeenCalledTimes(2);
      zeta.resolve(noEdit);
      expect((await response)?.[0]?.completion).toBe("return 42;");
      expect(onIntermediateResults).toHaveBeenCalledOnce();
    },
  );

  test.each(["no edit", "error", "malformed", "different insertion"])(
    "retains published FIM for Zeta %s",
    async (outcome) => {
      const { client, input, primary } = setup();
      const zeta = deferred<CompletionResult>();
      primary.mockReturnValue(zeta.promise);
      const published = deferred<AutocompleteResult[]>();
      input.onIntermediateResults = published.resolve;
      const response = client.getAutocomplete(input);
      const initial = await published.promise;
      if (outcome === "error") zeta.reject(new Error("Zeta unavailable"));
      else
        zeta.resolve(
          outcome === "no edit"
            ? noEdit
            : outcome === "malformed"
              ? { text: "<|marker_1|>", finishReason: "stop" }
              : zetaEdit,
        );
      const result = await response;
      expect(result).toEqual(initial);
      expect(result?.[0]?.completion).toBe("return 42;");
    },
  );

  test("publishes FIM before preparing or dispatching Zeta", async () => {
    const { client, input, primary, fallback, started } = setup();
    configure({ outlineSymbols: 1 });
    const events: string[] = [];
    const fim = deferred<CompletionResult>();
    fallback.mockReturnValue(fim.promise);
    vi.spyOn(vscode.commands, "executeCommand").mockImplementation(async (command) => {
      if (command === "vscode.executeDocumentSymbolProvider") events.push("prepare");
      return [];
    });
    primary.mockImplementation(async () => {
      events.push("zeta");
      return noEdit;
    });
    input.onIntermediateResults = () => events.push("publish");
    const response = client.getAutocomplete(input);
    await started.promise;
    expect(events).toEqual([]);
    expect(primary).not.toHaveBeenCalled();
    fim.resolve(continuation);
    expect((await response)?.[0]?.completion).toBe("return 42;");
    expect(events).toEqual(["publish", "prepare", "zeta"]);
  });

  test("continues after the intermediate results callback throws", async () => {
    const { client, input, primary } = setup();
    const published = vi.fn(() => {
      throw new Error("consumer failed");
    });
    input.onIntermediateResults = published;
    primary.mockResolvedValue(noEdit);

    const result = await client.getAutocomplete(input);

    expect(published).toHaveBeenCalledOnce();
    expect(primary).toHaveBeenCalledOnce();
    expect(result?.[0]?.completion).toBe("return 42;");
  });

  test("replaces published FIM with a substantive existing-code Zeta edit", async () => {
    const { client, input, primary, fallback, primaryStarted, started } = atCursor(
      "const oldName = 1;\nfunction demo() {\n  ¦\n}",
    );
    const zeta = deferred<CompletionResult>();
    const fim = deferred<CompletionResult>();
    primary.mockReturnValue(zeta.promise);
    fallback.mockReturnValue(fim.promise);
    const published = deferred<AutocompleteResult[]>();
    input.onIntermediateResults = published.resolve;
    const response = client.getAutocomplete(input);
    await started.promise;
    expect(primary).not.toHaveBeenCalled();
    fim.resolve(continuation);
    await published.promise;
    await primaryStarted.promise;
    zeta.resolve(zetaDocument("const newName = 1;\nfunction demo() {\n  return newName;\n}"));
    const result = await response;
    expect(result?.some((item) => item.completion.includes("newName"))).toBe(true);
    expect(result?.some((item) => item.source === "continuation")).toBe(false);
  });

  test.each(["error", "empty", "truncated"])(
    "starts Zeta only after FIM settles with %s",
    async (outcome) => {
      const { client, input, primary, fallback, server, started } = setup();
      const fim = deferred<CompletionResult>();
      fallback.mockReturnValue(fim.promise);
      primary.mockResolvedValue(zetaEdit);
      const response = client.getAutocomplete(input);
      await started.promise;
      expect(primary).not.toHaveBeenCalled();
      if (outcome === "error") fim.reject(new Error("FIM unavailable"));
      else
        fim.resolve({
          text: outcome === "empty" ? "" : "return 9;",
          finishReason: outcome === "truncated" ? "length" : "stop",
        });
      expect((await response)?.[0]?.completion).toBe("return 1;");
      expect(primary).toHaveBeenCalledOnce();
      expect(server.reportFailure).not.toHaveBeenCalled();
    },
  );

  test.each(["cancelled", "dismissed"])(
    "does not start Zeta when the delivered FIM is immediately %s",
    async (scenario) => {
      const { client, input, primary } = setup();
      const controller = new AbortController();
      let eligible = true;
      input.canUseContinuationFallback = () => eligible;
      const published = vi.fn(() => {
        if (scenario === "cancelled") controller.abort();
        else eligible = false;
      });
      input.onIntermediateResults = published;
      expect(await client.getAutocomplete(input, controller.signal)).toBeNull();
      expect(published).toHaveBeenCalledOnce();
      expect(primary).not.toHaveBeenCalled();
    },
  );

  test("deducts FIM generation time from the shared Zeta deadline", async () => {
    const { client, input, primary, fallback, started, complete } = setup();
    configure({ completionTimeoutMs: 1_000 });
    const fim = deferred<CompletionResult>();
    fallback.mockReturnValue(fim.promise);
    const response = client.getAutocomplete(input);
    await started.promise;
    await vi.advanceTimersByTimeAsync(400);
    expect(primary).not.toHaveBeenCalled();
    fim.resolve(continuation);
    expect((await response)?.[0]?.completion).toBe("return 42;");
    const request = complete.mock.calls.find(([request]) => request.model === MODEL_NAME)?.[0];
    expect(request?.timeoutMs).toBe(600);
  });

  test.each(["cursor", "version", "aborted", "deadline"])(
    "rejects a late FIM after %s invalidates it",
    async (scenario) => {
      const { client, input, primary, fallback, started, update } = setup();
      configure({ completionTimeoutMs: 1_000 });
      const fim = deferred<CompletionResult>();
      const zeta = deferred<CompletionResult>();
      fallback.mockReturnValue(fim.promise);
      primary.mockReturnValue(zeta.promise);
      let eligible = true;
      input.canUseContinuationFallback = () => eligible;
      const published = vi.fn();
      input.onIntermediateResults = published;
      const controller = new AbortController();
      const response = client.getAutocomplete(input, controller.signal);
      await started.promise;
      if (scenario === "cursor") eligible = false;
      if (scenario === "version") update(input.originalContent + " ");
      if (scenario === "aborted") controller.abort();
      if (scenario === "deadline") await vi.advanceTimersByTimeAsync(1_001);
      fim.resolve(continuation);
      zeta.resolve(noEdit);
      expect(await response).toBeNull();
      expect(published).not.toHaveBeenCalled();
      expect(primary).not.toHaveBeenCalled();
    },
  );

  test.each(["cursor", "version", "aborted", "deadline"])(
    "rejects a late Zeta upgrade after %s",
    async (scenario) => {
      const { client, input, primary, primaryStarted, update } = atCursor(
        "const oldName = 1;\nfunction demo() {\n  ¦\n}",
      );
      configure({ completionTimeoutMs: 1_000 });
      const zeta = deferred<CompletionResult>();
      primary.mockReturnValue(zeta.promise);
      const published = deferred<AutocompleteResult[]>();
      input.onIntermediateResults = published.resolve;
      let eligible = true;
      input.canUseContinuationFallback = () => eligible;
      const controller = new AbortController();
      const response = client.getAutocomplete(input, controller.signal);
      await published.promise;
      await primaryStarted.promise;
      if (scenario === "cursor") eligible = false;
      if (scenario === "version") update(input.originalContent + " ");
      if (scenario === "aborted") controller.abort();
      if (scenario === "deadline") await vi.advanceTimersByTimeAsync(1_001);
      zeta.resolve(zetaDocument("const newName = 1;\nfunction demo() {\n  return newName;\n}"));
      expect(await response).toBeNull();
    },
  );

  test.each(["absent", "ineligible", "aborted"])(
    "does not dispatch FIM for %s",
    async (scenario) => {
      const { client, input, fallback } = setup();
      if (scenario === "absent") delete input.canUseContinuationFallback;
      if (scenario === "ineligible") input.canUseContinuationFallback = () => false;
      const controller = new AbortController();
      if (scenario === "aborted") controller.abort();
      expect(await client.getAutocomplete(input, controller.signal)).toBeNull();
      expect(fallback).not.toHaveBeenCalled();
    },
  );

  test("does not replace FIM for whitespace-only Zeta changes", async () => {
    const { client, input, primary } = atCursor("const oldName = 1;\nfunction demo() {\n  ¦\n}");
    const zeta = deferred<CompletionResult>();
    primary.mockReturnValue(zeta.promise);
    const published = deferred<AutocompleteResult[]>();
    input.onIntermediateResults = published.resolve;
    const response = client.getAutocomplete(input);
    const initial = await published.promise;
    zeta.resolve(zetaDocument("const oldName=1;\nfunction demo() {\n  \n}"));
    expect(await response).toEqual(initial);
  });

  test("aborts the FIM request when its parent is cancelled", async () => {
    const { client, input, primary, fallback, started, fallbackSignal } = setup();
    const zeta = deferred<CompletionResult>();
    const fim = deferred<CompletionResult>();
    primary.mockReturnValue(zeta.promise);
    fallback.mockReturnValue(fim.promise);
    const controller = new AbortController();
    const response = client.getAutocomplete(input, controller.signal);
    await started.promise;
    expect(fallbackSignal()?.aborted).toBe(false);
    controller.abort();
    expect(fallbackSignal()?.aborted).toBe(true);
    fim.resolve(continuation);
    zeta.resolve(noEdit);
    expect(await response).toBeNull();
    expect(primary).not.toHaveBeenCalled();
  });

  test("reuses cached Zeta no-edit while generating fresh FIM results", async () => {
    const { client, input, primary, fallback } = setup();
    configure({ reuseIdenticalPromptResults: true });
    fallback
      .mockResolvedValueOnce({ text: "return 1;", finishReason: "stop" })
      .mockResolvedValueOnce({ text: "return 2;", finishReason: "stop" });
    expect((await client.getAutocomplete(input))?.[0]?.completion).toBe("return 1;");
    expect((await client.getAutocomplete(input))?.[0]?.completion).toBe("return 2;");
    expect(primary).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledTimes(2);
  });
});
