import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import * as vscode from "vscode";
import { SpanStatusCode } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  SimpleSpanProcessor,
  TracerProvider,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace";

import { ApiClient, type AutocompleteInput } from "~/api/client.ts";
import type { AutocompleteResult } from "~/api/schemas.ts";
import type { CompletionServer } from "~/services/completion-server.ts";
import { InlineEditProvider } from "~/editor/inline-edit-provider.ts";
import { JumpEditManager } from "~/editor/jump-edit-manager.ts";
import { registerInlineCompletionItemProviderWithMetadata } from "~/editor/proposed-inline-edit.ts";
import { DocumentTracker } from "~/telemetry/document-tracker.ts";
import { ExtensionTelemetry } from "~/core/telemetry.ts";
import { continuationDocument } from "./fixtures/continuation-document.ts";

const originalWritable = Object.getOwnPropertyDescriptor(
  vscode.workspace.fs,
  "isWritableFileSystem",
);
const originalDiagnostics = vscode.languages.getDiagnostics;
const trackers: DocumentTracker[] = [];

function createTestTelemetry() {
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
  return { finishedSpans, telemetry: new ExtensionTelemetry(provider) };
}

function configure(values: Record<string, unknown> = {}) {
  (
    globalThis as typeof globalThis & { __vscodeMockConfiguration?: Record<string, unknown> }
  ).__vscodeMockConfiguration = { maxContextFiles: 0, ...values };
}

afterEach(() => {
  trackers.splice(0).forEach((tracker) => tracker.dispose());
  configure();
  registerInlineCompletionItemProviderWithMetadata(
    [],
    {} as vscode.InlineCompletionItemProvider,
    {},
  ).dispose();
  (vscode.window as unknown as { activeTextEditor: undefined }).activeTextEditor = undefined;
  if (originalWritable) {
    Object.defineProperty(vscode.workspace.fs, "isWritableFileSystem", originalWritable);
  } else {
    Reflect.deleteProperty(vscode.workspace.fs, "isWritableFileSystem");
  }
  vscode.languages.getDiagnostics = originalDiagnostics;
  vi.restoreAllMocks();
});

describe("InlineEditProvider nearby rename display", () => {
  test.each(["INLINE", "JUMP"] as const)(
    "lets the first eligible candidate choose %s display after no-op and suppressed edits",
    async (firstDecision) => {
      configure({ outlineSymbols: 0 });
      vscode.workspace.fs.isWritableFileSystem = () => true;
      vscode.languages.getDiagnostics = () => [];
      const { document } = continuationDocument("abcd");
      const position = new vscode.Position(0, 0);
      const selection = Object.assign(new vscode.Selection(position, position), { isEmpty: true });
      (vscode.window as unknown as { activeTextEditor: vscode.TextEditor }).activeTextEditor = {
        document,
        selection,
        selections: [selection],
      } as unknown as vscode.TextEditor;
      const tracker = new DocumentTracker();
      trackers.push(tracker);
      tracker.setActiveFile(document);
      const first: AutocompleteResult = {
        id: "first-eligible",
        startIndex: 0,
        endIndex: 0,
        completion: "first",
      };
      const later: AutocompleteResult = { ...first, id: "later-eligible", completion: "later" };
      const noOp: AutocompleteResult = {
        id: "no-op",
        startIndex: 0,
        endIndex: 1,
        completion: "a",
      };
      const suppressed = { ...first, id: "suppressed", completion: "hidden" };
      const classify = vi.fn(
        (
          _document: vscode.TextDocument,
          _position: vscode.Position,
          result: AutocompleteResult,
        ) => ({
          decision:
            result.id === "suppressed"
              ? "SUPPRESS"
              : result.id === first.id
                ? firstDecision
                : firstDecision === "INLINE"
                  ? "JUMP"
                  : "INLINE",
        }),
      );
      const provider = new InlineEditProvider(
        tracker,
        {
          classifyEditDisplay: classify,
        } as unknown as JumpEditManager,
        { getAutocomplete: async () => [noOp, suppressed, first, later] } as unknown as ApiClient,
      );
      try {
        const result = await provider.provideInlineCompletionItems(
          document,
          position,
          {
            triggerKind: vscode.InlineCompletionTriggerKind.Invoke,
            selectedCompletionInfo: undefined,
          },
          { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
        );
        expect(result?.items).toHaveLength(1);
        expect(result?.items[0]?.insertText).toBe("first");
        if (firstDecision === "JUMP") {
          expect(result?.items[0]).toMatchObject({ isInlineEdit: true });
        }
      } finally {
        provider.dispose();
      }
    },
  );

  test("returns reference edits as native items without changing the document", async () => {
    configure({ outlineSymbols: 0 });
    vscode.workspace.fs.isWritableFileSystem = () => true;
    vscode.languages.getDiagnostics = () => [];
    const text = [
      "const newBeginning = edit.start;",
      "",
      "const start = newStart;",
      "const end = newStart + edit.length;",
    ].join("\n");
    const { document } = continuationDocument(text);
    const position = new vscode.Position(0, "const newBeginning".length);
    const selection = Object.assign(new vscode.Selection(position, position), { isEmpty: true });
    const setDecorations = vi.fn();
    const editor = {
      document,
      selection,
      selections: [selection],
      setDecorations,
    } as unknown as vscode.TextEditor;
    (vscode.window as unknown as { activeTextEditor: vscode.TextEditor }).activeTextEditor = editor;
    const tracker = new DocumentTracker();
    trackers.push(tracker);
    tracker.setActiveFile(document);
    const suggestion: AutocompleteResult = {
      id: "rename-references",
      startIndex: text.indexOf("const start"),
      endIndex: text.length,
      completion: "const start = newBeginning;\nconst end = newBeginning + edit.length;",
    };
    const getAutocomplete = vi.fn().mockResolvedValue([suggestion]);
    const jumpManager = new JumpEditManager();
    const { finishedSpans, telemetry } = createTestTelemetry();
    const provider = new InlineEditProvider(
      tracker,
      jumpManager,
      {
        getAutocomplete,
      } as unknown as ApiClient,
      telemetry,
    );

    try {
      const result = await provider.provideInlineCompletionItems(
        document,
        position,
        {
          triggerKind: vscode.InlineCompletionTriggerKind.Invoke,
          selectedCompletionInfo: undefined,
        },
        {
          isCancellationRequested: false,
          onCancellationRequested: () => ({ dispose() {} }),
        },
      );

      expect(getAutocomplete).toHaveBeenCalledTimes(1);
      expect(result?.items).toHaveLength(1);
      expect(result?.items[0]).toMatchObject({ isInlineEdit: true });
      expect(setDecorations).not.toHaveBeenCalled();
      const completionSpans = finishedSpans.filter((span) => span.name === "nesweep.completion");
      expect(completionSpans).toHaveLength(1);
      expect(completionSpans[0]?.ended).toBe(true);
      await telemetry.shutdown();
      expect(document.getText()).toBe(text);
    } finally {
      provider.dispose();
    }
  });
});

describe("InlineEditProvider continuation eligibility callback", () => {
  test.each([
    ["const answer = ", ";", "42", "42", "const answer = 42;"],
    ["console.log(", ");", '"ready"', '"ready"', 'console.log("ready");'],
    ["outer(", ")", "inner()", "inner()", "outer(inner())"],
    ["outer(", ")", "inner())", "inner())", "outer(inner()))"],
    ["outer(", ")", 'inner(")")', 'inner(")")', 'outer(inner(")"))'],
    ["const values = [", "]", "[1]", "[1]", "const values = [[1]]"],
  ])(
    "offers fallback without a prior Enter between %j and %j",
    async (before, after, generated, inserted, accepted) => {
      configure({ outlineSymbols: 0 });
      vscode.workspace.fs.isWritableFileSystem = () => true;
      vscode.languages.getDiagnostics = () => [];
      const text = before + after;
      const { document } = continuationDocument(text);
      const position = new vscode.Position(0, before.length);
      const selection = Object.assign(new vscode.Selection(position, position), { isEmpty: true });
      const editor = {
        document,
        selection,
        selections: [selection],
      } as unknown as vscode.TextEditor;
      (vscode.window as unknown as { activeTextEditor: vscode.TextEditor }).activeTextEditor =
        editor;
      const tracker = new DocumentTracker();
      trackers.push(tracker);
      tracker.setActiveFile(document);
      const complete = vi.fn(({ model }: { model: string }) =>
        Promise.resolve({
          text: model === "zeta-2.1" ? "<|marker_1|><|marker_1|>" : generated,
          finishReason: "stop",
        }),
      );
      const api = new ApiClient({
        waitUntilReady: async () => {},
        getClient: () => ({ complete }),
        reportSuccess() {},
        reportFailure() {},
      } as unknown as CompletionServer);
      vi.spyOn(api, "getDebugInfo").mockReturnValue("test");
      const provider = new InlineEditProvider(
        tracker,
        {
          classifyEditDisplay: () => ({ decision: "INLINE" }),
        } as unknown as JumpEditManager,
        api,
      );

      const result = await provider.provideInlineCompletionItems(
        document,
        position,
        {
          triggerKind: vscode.InlineCompletionTriggerKind.Invoke,
          selectedCompletionInfo: undefined,
        },
        { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
      );

      // The provider returns the early FIM item while the Zeta request continues.
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
      expect(result?.items).toHaveLength(1);
      const item = result!.items[0]!;
      expect(item.insertText).toBe(inserted);
      expect(item.range?.start).toEqual(position);
      expect(item.range?.end).toEqual(position);
      if (typeof item.insertText !== "string") throw new Error("Expected plain-text insertion");
      const offset = document.offsetAt(position);
      expect(text.slice(0, offset) + item.insertText + text.slice(offset)).toBe(accepted);
      expect(document.getText()).toBe(text);
    },
  );

  test("ignores a legacy disabled setting and keeps nested and existing outer closing braces", async () => {
    configure({ continuationFallbackEnabled: false, outlineSymbols: 0 });
    vscode.workspace.fs.isWritableFileSystem = () => true;
    vscode.languages.getDiagnostics = () => [];
    const { document } = continuationDocument("function demo() {\n\n}");
    const position = new vscode.Position(1, 0);
    const selection = Object.assign(new vscode.Selection(position, position), { isEmpty: true });
    const editor = { document, selection, selections: [selection] } as unknown as vscode.TextEditor;
    (vscode.window as unknown as { activeTextEditor: vscode.TextEditor }).activeTextEditor = editor;
    const tracker = new DocumentTracker();
    trackers.push(tracker);
    tracker.setActiveFile(document);
    const complete = vi.fn(({ model }: { model: string }) =>
      Promise.resolve({
        text: model === "zeta-2.1" ? "<|marker_1|><|marker_1|>" : "if (ready) {\nrun();\n}\n}",
        finishReason: "stop",
      }),
    );
    const api = new ApiClient({
      waitUntilReady: async () => {},
      getClient: () => ({ complete }),
      reportSuccess() {},
      reportFailure() {},
    } as unknown as CompletionServer);
    vi.spyOn(api, "getDebugInfo").mockReturnValue("test");
    const provider = new InlineEditProvider(
      tracker,
      {
        classifyEditDisplay: () => ({ decision: "INLINE" }),
      } as unknown as JumpEditManager,
      api,
    );

    const result = await provider.provideInlineCompletionItems(
      document,
      position,
      {
        triggerKind: vscode.InlineCompletionTriggerKind.Invoke,
        selectedCompletionInfo: undefined,
      },
      {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose() {} }),
      },
    );

    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    expect(result?.items).toHaveLength(1);
    const item = result!.items[0]!;
    expect(item.insertText).toBe("if (ready) {\nrun();\n}");
    expect(item.range?.start).toEqual(position);
    expect(item.range?.end).toEqual(position);
    if (typeof item.insertText !== "string") throw new Error("Expected a plain-text continuation");
    const offset = document.offsetAt(position);
    const acceptedText =
      document.getText().slice(0, offset) + item.insertText + document.getText().slice(offset);
    expect(acceptedText).toBe("function demo() {\nif (ready) {\nrun();\n}\n}");
  });

  test.each(["cursor", "version", "cancel", "newer request"])(
    "rechecks %s after the API request starts",
    async (scenario) => {
      configure();
      vscode.workspace.fs.isWritableFileSystem = () => true;
      vscode.languages.getDiagnostics = () => [];
      const { document, update } = continuationDocument();
      const position = new vscode.Position(1, 2);
      const selection = Object.assign(new vscode.Selection(position, position), { isEmpty: true });
      const editor = {
        document,
        selection,
        selections: [selection],
      } as unknown as vscode.TextEditor;
      (vscode.window as unknown as { activeTextEditor: vscode.TextEditor }).activeTextEditor =
        editor;
      const tracker = new DocumentTracker();
      trackers.push(tracker);
      tracker.setActiveFile(document);
      let capturedInput: AutocompleteInput | undefined;
      const api = {
        getAutocomplete: async (input: AutocompleteInput) => {
          capturedInput = input;
          return null;
        },
      } as unknown as ApiClient;
      const provider = new InlineEditProvider(tracker, {} as JumpEditManager, api);
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose() {} }),
      };
      const context = {
        triggerKind: vscode.InlineCompletionTriggerKind.Invoke,
        selectedCompletionInfo: undefined,
      };

      expect(
        await provider.provideInlineCompletionItems(document, position, context, token),
      ).toBeUndefined();
      expect(capturedInput?.canUseContinuationFallback?.()).toBe(true);

      if (scenario === "cursor") {
        const away = new vscode.Position(0, 0);
        editor.selection = new vscode.Selection(away, away);
      }
      if (scenario === "version") update(document.getText());
      if (scenario === "cancel") token.isCancellationRequested = true;
      if (scenario === "newer request") {
        configure({ enabled: false });
        await provider.provideInlineCompletionItems(document, position, context, token);
        configure();
      }

      expect(capturedInput?.canUseContinuationFallback?.()).toBe(false);
    },
  );
});

describe("InlineEditProvider completion trace lifecycle", () => {
  test.each([
    ["no edit", "no_edit"],
    ["error", "error"],
    ["build input error", "error"],
    ["cancel", "cancelled"],
    ["stale", "no_edit"],
    ["dispose", "disposed"],
    ["success", "inline_handoff"],
  ] as const)("ends the root span for %s", async (scenario, expectedOutcome) => {
    configure({ maxContextFiles: 0, outlineSymbols: 0 });
    vscode.workspace.fs.isWritableFileSystem = () => true;
    vscode.languages.getDiagnostics = () => [];
    const documentCanary = "private-document-canary-7d3b";
    const text = `const answer = '${documentCanary}'; `;
    const { document, update } = continuationDocument(text);
    const position = new vscode.Position(0, text.length);
    const selection = Object.assign(new vscode.Selection(position, position), { isEmpty: true });
    const editor = { document, selection, selections: [selection] } as unknown as vscode.TextEditor;
    (vscode.window as unknown as { activeTextEditor: vscode.TextEditor }).activeTextEditor = editor;
    const tracker = new DocumentTracker();
    trackers.push(tracker);
    tracker.setActiveFile(document);

    let finishRequest!: (response: AutocompleteResult[] | null) => void;
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const response = new Promise<AutocompleteResult[] | null>((resolve) => {
      finishRequest = resolve;
    });
    const suggestion: AutocompleteResult = {
      id: "trace-lifecycle",
      startIndex: text.length,
      endIndex: text.length,
      completion: "42",
    };
    const getAutocomplete = vi.fn(() => {
      markRequestStarted();
      if (scenario === "no edit") return Promise.resolve(null);
      if (scenario === "error" || scenario === "build input error")
        return Promise.reject(new Error("Raw error with sensitive details"));
      if (scenario === "success") return Promise.resolve([suggestion]);
      return response;
    });
    const api = { getAutocomplete } as unknown as ApiClient;
    const jumpManager = {
      classifyEditDisplay: () => ({ decision: "INLINE" as const }),
    } as unknown as JumpEditManager;
    const { finishedSpans, telemetry } = createTestTelemetry();
    const provider = new InlineEditProvider(tracker, jumpManager, api, telemetry);
    if (scenario === "build input error") {
      vi.spyOn(
        provider as unknown as { buildInput: (...args: unknown[]) => AutocompleteInput },
        "buildInput",
      ).mockImplementation(() => {
        throw new Error("Raw build input error with sensitive details");
      });
    }
    let cancellationListener: (() => void) | undefined;
    let cancellationRequested = false;
    const token = {
      get isCancellationRequested() {
        return cancellationRequested;
      },
      onCancellationRequested(listener: () => void) {
        cancellationListener = listener;
        return { dispose() {} };
      },
    } as unknown as vscode.CancellationToken;
    const completion = provider.provideInlineCompletionItems(
      document,
      position,
      {
        triggerKind: vscode.InlineCompletionTriggerKind.Invoke,
        selectedCompletionInfo: undefined,
      },
      token,
    );

    if (scenario === "cancel" || scenario === "stale" || scenario === "dispose") {
      await requestStarted;
      if (scenario === "cancel") {
        cancellationRequested = true;
        cancellationListener?.();
        finishRequest(null);
      } else if (scenario === "stale") {
        update(text + "changed");
        finishRequest([suggestion]);
      } else {
        provider.dispose();
        finishRequest(null);
      }
    }

    if (scenario === "build input error") {
      await expect(completion).rejects.toThrow("Raw build input error with sensitive details");
    } else {
      const result = await completion;
      if (scenario === "success") expect(result?.items).toHaveLength(1);
      else expect(result).toBeUndefined();
    }

    expect(getAutocomplete).toHaveBeenCalledTimes(scenario === "build input error" ? 0 : 1);
    const completionSpans = finishedSpans.filter((span) => span.name === "nesweep.completion");
    expect(completionSpans).toHaveLength(1);
    expect(completionSpans[0]?.ended).toBe(true);
    expect(completionSpans[0]?.attributes["nesweep.outcome"]).toBe(expectedOutcome);
    if (scenario === "error" || scenario === "build input error")
      expect(completionSpans[0]?.status.code).toBe(SpanStatusCode.ERROR);
    if (scenario === "build input error") {
      const buildInputSpans = finishedSpans.filter(
        (span) => span.name === "nesweep.provider.build_input",
      );
      expect(buildInputSpans).toHaveLength(1);
      expect(buildInputSpans[0]?.ended).toBe(true);
      expect(buildInputSpans[0]?.status.code).toBe(SpanStatusCode.ERROR);
      expect(buildInputSpans[0]?.attributes["error.type"]).toBe("Error");
    }
    const exported = JSON.stringify(
      finishedSpans.map(({ name, attributes, events, status, links }) => ({
        name,
        attributes,
        events,
        status,
        links,
      })),
    );
    expect(exported).not.toContain("Raw error with sensitive details");
    expect(exported).not.toContain("Raw build input error with sensitive details");
    expect(exported).not.toContain(documentCanary);
    await telemetry.shutdown();
    provider.dispose();
  });
});

describe("InlineEditProvider FIM handoff and Zeta upgrades", () => {
  test("keeps the first nonempty synchronous FIM publication when the final request rejects", async () => {
    configure({ outlineSymbols: 0 });
    vscode.workspace.fs.isWritableFileSystem = () => true;
    vscode.languages.getDiagnostics = () => [];
    const { document } = continuationDocument();
    const position = new vscode.Position(1, 2);
    const selection = Object.assign(new vscode.Selection(position, position), { isEmpty: true });
    (vscode.window as unknown as { activeTextEditor: vscode.TextEditor }).activeTextEditor = {
      document,
      selection,
      selections: [selection],
    } as unknown as vscode.TextEditor;
    const tracker = new DocumentTracker();
    trackers.push(tracker);
    tracker.setActiveFile(document);
    const offset = document.offsetAt(position);
    const fim: AutocompleteResult = {
      id: "synchronous-fim",
      source: "continuation",
      startIndex: offset,
      endIndex: offset,
      completion: "return 42;",
    };
    const getAutocomplete = vi.fn((input: AutocompleteInput) => {
      input.onIntermediateResults?.([]);
      input.onIntermediateResults?.([fim]);
      input.onIntermediateResults?.([{ ...fim, id: "duplicate-fim", completion: "return 99;" }]);
      return Promise.reject(new Error("Final generation unavailable"));
    });
    const provider = new InlineEditProvider(
      tracker,
      {
        classifyEditDisplay: () => ({ decision: "INLINE" }),
      } as unknown as JumpEditManager,
      { getAutocomplete } as unknown as ApiClient,
    );
    try {
      const result = await provider.provideInlineCompletionItems(
        document,
        position,
        {
          triggerKind: vscode.InlineCompletionTriggerKind.Invoke,
          selectedCompletionInfo: undefined,
        },
        { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
      );
      expect(result?.items).toHaveLength(1);
      expect(result?.items[0]?.insertText).toBe("return 42;");
      expect(getAutocomplete).toHaveBeenCalledOnce();
    } finally {
      provider.dispose();
    }
  });

  test.each([
    "visible",
    "not shown",
    "typing",
    "cursor",
    "accept",
    "reject",
    "end",
    "cancel",
    "newer request",
    "same FIM",
  ])("only replaces a visible unchanged FIM item: %s", async (scenario) => {
    configure({ outlineSymbols: 0 });
    vscode.workspace.fs.isWritableFileSystem = () => true;
    vscode.languages.getDiagnostics = () => [];
    const { document, update } = continuationDocument();
    const position = new vscode.Position(1, 2);
    const selection = Object.assign(new vscode.Selection(position, position), { isEmpty: true });
    const editor = { document, selection, selections: [selection] } as unknown as vscode.TextEditor;
    (vscode.window as unknown as { activeTextEditor: vscode.TextEditor }).activeTextEditor = editor;
    const tracker = new DocumentTracker();
    trackers.push(tracker);
    tracker.setActiveFile(document);
    let publish!: (results: AutocompleteResult[]) => void;
    let requestedInput: AutocompleteInput | undefined;
    let finish!: (results: AutocompleteResult[]) => void;
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const final = new Promise<AutocompleteResult[]>((resolve) => {
      finish = resolve;
    });
    const getAutocomplete = vi.fn((input: AutocompleteInput) => {
      requestedInput = input;
      publish = input.onIntermediateResults!;
      started();
      return final;
    });
    const offset = document.offsetAt(position);
    const fim: AutocompleteResult = {
      id: "fim-early",
      source: "continuation",
      startIndex: offset,
      endIndex: offset,
      completion: "return 42;",
    };
    const upgrade: AutocompleteResult = {
      id: "zeta-upgrade",
      startIndex: 0,
      endIndex: document.getText().length,
      completion: "function renamed() {\n  return 42;\n}",
    };
    const provider = new InlineEditProvider(
      tracker,
      {
        classifyEditDisplay: (
          _document: vscode.TextDocument,
          _position: vscode.Position,
          result: AutocompleteResult,
        ) => ({ decision: result.source === "continuation" ? "INLINE" : "JUMP" }),
      } as unknown as JumpEditManager,
      { getAutocomplete } as unknown as ApiClient,
    );
    const proposalRegistration =
      scenario === "visible"
        ? registerInlineCompletionItemProviderWithMetadata([], provider, {})
        : undefined;
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    };
    const context = {
      triggerKind: vscode.InlineCompletionTriggerKind.Invoke,
      selectedCompletionInfo: undefined,
    };
    const execute = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    try {
      const pending = provider.provideInlineCompletionItems(document, position, context, token);
      await requestStarted;
      expect(publish).toBeTypeOf("function");
      publish([fim]);
      const initial = await pending;
      expect(initial?.items).toHaveLength(1);
      const item = initial!.items[0]!;
      expect(item.insertText).toBe("return 42;");
      if (scenario !== "not shown") provider.handleDidShowCompletionItem(item);
      if (scenario === "typing") update(document.getText() + "x");
      if (scenario === "cursor") {
        const away = new vscode.Position(0, 0);
        editor.selection = new vscode.Selection(away, away);
      }
      if (scenario === "accept") provider.handleInlineAccept(item.command?.arguments?.[0]);
      if (scenario === "reject") provider.handleDidRejectCompletionItem(item);
      if (scenario === "end") provider.handleEndOfLifetime(item);
      if (scenario === "cancel") token.isCancellationRequested = true;
      if (scenario === "newer request") {
        configure({ enabled: false });
        await provider.provideInlineCompletionItems(document, position, context, token);
        configure();
      }
      if (
        ["typing", "cursor", "accept", "reject", "end", "cancel", "newer request"].includes(
          scenario,
        )
      ) {
        expect(requestedInput?.canUseContinuationFallback?.()).toBe(false);
      }
      execute.mockClear();
      finish(scenario === "same FIM" ? [fim] : [upgrade]);
      // The provider registered its final-result handler before this await.
      await final;
      const refreshes = execute.mock.calls.filter(
        ([command]) => command === "editor.action.inlineSuggest.trigger",
      );
      expect(refreshes).toHaveLength(scenario === "visible" ? 1 : 0);
      if (scenario === "visible") {
        const result = await provider.provideInlineCompletionItems(
          document,
          position,
          context,
          token,
        );
        expect(result?.items).toHaveLength(1);
        expect(result?.items[0]?.insertText).toContain("renamed");
        expect(getAutocomplete).toHaveBeenCalledOnce();
        expect(result?.items[0]?.insertText).not.toBe("return 42;");
      }
    } finally {
      proposalRegistration?.dispose();
      provider.dispose();
    }
  });
});
