import * as vscode from "vscode";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { formatRecentChanges } from "~/api/history.ts";
import { buildZetaPrompt } from "~/api/prompt.ts";
import { buildRetrievalChunks } from "~/api/retrieval-chunks.ts";
import { loadWorkspaceRules } from "~/api/rules.ts";
import { SymbolOutlineProvider } from "~/api/symbol-outline.ts";
import type { AutocompleteRequest, RecentChange } from "~/api/schemas.ts";
import { RulesDiagnostics } from "~/extension/rules-diagnostics.ts";

const mutableVscode = vscode as unknown as {
  [key: string]: unknown;
  languages: Record<string, unknown>;
  workspace: Record<string, unknown>;
  window: Record<string, unknown>;
};

function document(
  text: string,
  options: { path?: string; languageId?: string; version?: number } = {},
): vscode.TextDocument {
  const lines = text.split("\n");
  const path = options.path ?? "/workspace/src/main.ts";
  return {
    uri: { scheme: "file", fsPath: path, path, toString: () => `file://${path}` } as vscode.Uri,
    languageId: options.languageId ?? "typescript",
    version: options.version ?? 1,
    lineCount: lines.length,
    getText: () => text,
    lineAt: (line: number) => ({ text: lines[line] ?? "" }),
    positionAt: (offset: number) => {
      let remaining = offset;
      for (let line = 0; line < lines.length; line++) {
        const length = lines[line]?.length ?? 0;
        if (remaining <= length) return new vscode.Position(line, remaining);
        remaining -= length + 1;
      }
      return new vscode.Position(Math.max(0, lines.length - 1), lines.at(-1)?.length ?? 0);
    },
    offsetAt: (position: vscode.Position) =>
      lines.slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) +
      position.character,
  } as vscode.TextDocument;
}

Object.assign(vscode.Position.prototype, {
  isBeforeOrEqual(this: vscode.Position, other: vscode.Position) {
    return (
      this.line < other.line || (this.line === other.line && this.character <= other.character)
    );
  },
  isAfterOrEqual(this: vscode.Position, other: vscode.Position) {
    return (
      this.line > other.line || (this.line === other.line && this.character >= other.character)
    );
  },
});

Object.defineProperty(mutableVscode, "SymbolKind", {
  configurable: true,
  value: { 4: "Class", 11: "Function", Class: 4, Function: 11 },
});

function makeLocation(uri: vscode.Uri, range: vscode.Range): vscode.Location {
  class MockLocation {
    constructor(
      public uri: vscode.Uri,
      public range: vscode.Range,
    ) {}
  }
  Object.defineProperty(mutableVscode, "Location", { configurable: true, value: MockLocation });
  return new MockLocation(uri, range) as unknown as vscode.Location;
}

function request(overrides: Partial<AutocompleteRequest> = {}): AutocompleteRequest {
  return {
    debug_info: "",
    repo_name: "repo",
    file_path: "src/main.ts",
    file_contents: "const answer = 42;\nanswer;\n",
    original_file_contents: "const answer = 42;\nanswer;\n",
    cursor_position: 23,
    recent_changes: "",
    changes_above_cursor: false,
    multiple_suggestions: false,
    file_chunks: [],
    retrieval_chunks: [],
    editor_diagnostics: [],
    recent_user_actions: [],
    use_bytes: true,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("symbol outline context contract", () => {
  test("returns the previous outline while refreshing a changed document version", async () => {
    const doc = document("function first() {}", { version: 1 });
    const range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 19));
    const firstSymbol = {
      name: "first",
      kind: 4,
      location: makeLocation(doc.uri, range),
    } as unknown as vscode.SymbolInformation;
    const load = vi.fn(async () => [firstSymbol]);
    const provider = new SymbolOutlineProvider({ enabled: true, documentSymbolLoader: load });

    expect(provider.getOutline(doc, new vscode.Position(0, 4))).toBe("");
    await vi.waitFor(() =>
      expect(provider.getOutline(doc, new vscode.Position(0, 4))).toContain("first"),
    );

    const refreshedDoc = document("function second() {}", { version: 2 });
    const refreshedSymbol = {
      name: "second",
      kind: 4,
      location: makeLocation(doc.uri, range),
    } as unknown as vscode.SymbolInformation;
    load.mockImplementationOnce(async () => [refreshedSymbol]);
    const stale = provider.getOutline(refreshedDoc, new vscode.Position(0, 4));
    expect(stale).toContain("first");
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(load).toHaveBeenCalledTimes(2);
    await vi.waitFor(() =>
      expect(provider.getOutline(refreshedDoc, new vscode.Position(0, 4))).toContain("second"),
    );
    provider.dispose();
  });

  test("coalesces same-version requests and applies timeout backoff before retrying", async () => {
    vi.useFakeTimers();
    const resolvers: Array<(symbols: vscode.DocumentSymbol[]) => void> = [];
    const load = vi.fn(
      () => new Promise<vscode.DocumentSymbol[]>((resolve) => resolvers.push(resolve)),
    );
    const provider = new SymbolOutlineProvider({
      enabled: true,
      documentSymbolLoader: load,
      timeoutMs: 25,
      retryBackoffMs: 100,
    });
    const doc = document("const item = 1;", { path: "/workspace/src/cache.ts" });

    provider.getOutline(doc, new vscode.Position(0, 6));
    provider.getOutline(doc, new vscode.Position(0, 9));
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(25);
    resolvers[0]?.([]);
    await Promise.resolve();
    await Promise.resolve();
    provider.getOutline(doc, new vscode.Position(0, 6));
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    provider.getOutline(doc, new vscode.Position(0, 6));
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(2);
    provider.dispose();
  });

  test("renders flat symbols as a bounded outline around the cursor", () => {
    const provider = new SymbolOutlineProvider({
      enabled: true,
      documentSymbolLoader: async () => [
        {
          name: "Widget",
          kind: 4,
          location: makeLocation(
            {
              scheme: "file",
              path: "/workspace/src/widget.ts",
              fsPath: "/workspace/src/widget.ts",
              toString: () => "file:///workspace/src/widget.ts",
            } as vscode.Uri,
            new vscode.Range(new vscode.Position(2, 0), new vscode.Position(2, 6)),
          ),
        } as unknown as vscode.SymbolInformation,
      ],
    });
    const doc = document("\n\nclass Widget {}", { path: "/workspace/src/widget.ts" });
    provider.getOutline(doc, new vscode.Position(2, 1));
    return vi.waitFor(() => {
      const outline = provider.getOutline(doc, new vscode.Position(2, 1));
      expect(outline).toContain("Widget");
      expect(outline).toContain("3");
      provider.dispose();
    });
  });
});

describe("edit history context contract", () => {
  test("renders selected recent edits chronologically within event and character limits", () => {
    const changes: RecentChange[] = Array.from({ length: 8 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      diff: `@@ -1 +1 @@\n-old-${index}\n+new-${index}`,
    }));

    const output = formatRecentChanges(changes, { maxEvents: 3, maxCharacters: 1_000 });
    expect(output).toContain("file-0.ts");
    expect(output).toContain("file-1.ts");
    expect(output).toContain("file-2.ts");
    expect(output).not.toContain("file-3.ts");
    expect(output.indexOf("file-2.ts")).toBeLessThan(output.indexOf("file-0.ts"));
    expect(
      formatRecentChanges(changes, { maxEvents: 3, maxCharacters: 42 }).length,
    ).toBeLessThanOrEqual(42);
  });
});

describe("retrieval context contract", () => {
  test("normalizes Location and LocationLink targets, reads closed files, and deduplicates results", async () => {
    const active = document("const value = useThing();", { path: "/workspace/src/main.ts" });
    const targetUri = {
      scheme: "file",
      fsPath: "/workspace/src/target.ts",
      path: "/workspace/src/target.ts",
      toString: () => "file:///workspace/src/target.ts",
    } as vscode.Uri;
    const targetRange = new vscode.Range(new vscode.Position(10, 0), new vscode.Position(10, 4));
    const location = makeLocation(targetUri, targetRange);
    const link = {
      originSelectionRange: undefined,
      targetUri,
      targetRange,
      targetSelectionRange: targetRange,
    } as unknown as vscode.LocationLink;
    const execute = vi
      .spyOn(vscode.commands, "executeCommand")
      .mockImplementation(async (command) => {
        if (command === "vscode.executeDefinitionProvider") return [location, link];
        if (command === "vscode.executeReferenceProvider") return [location];
        return undefined;
      });
    const readFile = vi
      .spyOn(vscode.workspace.fs, "readFile")
      .mockResolvedValue(
        new TextEncoder().encode(
          Array.from({ length: 30 }, (_, line) => `line ${line}`).join("\n"),
        ),
      );
    const chunks = await buildRetrievalChunks({
      document: active,
      position: new vscode.Position(0, 15),
      currentFilePath: "/workspace/src/main.ts",
      openDocumentsProvider: () => [],
    });

    expect(execute).toHaveBeenCalled();
    expect(readFile).toHaveBeenCalled();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.file_path).toContain("target.ts");
    expect(chunks[0]?.content).toContain("line 10");
  });

  test("uses an open target document and omits provider and file-read failures", async () => {
    const active = document("useThing();", { path: "/workspace/src/main.ts" });
    const target = document("export const useThing = 1;", { path: "/workspace/src/target.ts" });
    const targetUri = target.uri;
    const location = makeLocation(
      targetUri,
      new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 6)),
    );
    vi.spyOn(vscode.commands, "executeCommand").mockImplementation(async (command) => {
      if (command === "vscode.executeDefinitionProvider") return [location];
      if (command === "vscode.executeReferenceProvider") throw new Error("provider unavailable");
      return undefined;
    });
    const readFile = vi
      .spyOn(vscode.workspace.fs, "readFile")
      .mockRejectedValue(new Error("unreadable"));
    const chunks = await buildRetrievalChunks({
      document: active,
      position: new vscode.Position(0, 3),
      openDocumentsProvider: () => [target],
    });

    expect(chunks.some((chunk) => chunk.content.includes("useThing"))).toBe(true);
    expect(readFile).not.toHaveBeenCalled();
  });

  test("omits a definition when its closed target cannot be read", async () => {
    const targetUri = {
      scheme: "file",
      fsPath: "/workspace/src/missing.ts",
      path: "/workspace/src/missing.ts",
      toString: () => "file:///workspace/src/missing.ts",
    } as vscode.Uri;
    vi.spyOn(vscode.commands, "executeCommand").mockImplementation(async (command) =>
      command === "vscode.executeDefinitionProvider"
        ? [
            makeLocation(
              targetUri,
              new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1)),
            ),
          ]
        : undefined,
    );
    vi.spyOn(vscode.workspace.fs, "readFile").mockRejectedValue(new Error("missing"));
    const chunks = await buildRetrievalChunks({
      document: document("useThing();"),
      position: new vscode.Position(0, 3),
      openDocumentsProvider: () => [],
    });
    expect(chunks).toEqual([]);
  });

  test("includes nonempty clipboard text as a bounded related chunk", async () => {
    Object.defineProperty(mutableVscode, "env", {
      configurable: true,
      value: { clipboard: { readText: vi.fn().mockResolvedValue("copied context") } },
    });
    const chunks = await buildRetrievalChunks({
      document: document("useThing();"),
      position: new vscode.Position(0, 3),
      includeClipboard: true,
    });
    expect(chunks).toContainEqual(
      expect.objectContaining({ file_path: "clipboard.txt", content: "copied context" }),
    );
  });
});

describe("rules and diagnostic context contract", () => {
  test("loads workspace-scoped rules as comments and ignores file-system failures", async () => {
    const workspaceUri = {
      scheme: "file",
      fsPath: "/workspace",
      path: "/workspace",
      toString: () => "file:///workspace",
    } as vscode.Uri;
    Object.defineProperty(vscode.Uri, "joinPath", {
      configurable: true,
      value: (base: vscode.Uri, ...parts: string[]) => {
        const path = `${base.fsPath}/${parts.join("/")}`;
        return { scheme: "file", fsPath: path, path, toString: () => `file://${path}` };
      },
    });
    vi.spyOn(vscode.workspace, "getWorkspaceFolder").mockReturnValue({
      uri: workspaceUri,
      name: "workspace",
      index: 0,
    });
    vi.spyOn(vscode.workspace.fs, "stat").mockResolvedValue({ mtime: 10 } as vscode.FileStat);
    vi.spyOn(vscode.workspace.fs, "readFile").mockResolvedValue(
      new TextEncoder().encode("Use the public API.\n\nKeep it stable."),
    );
    const doc = document("", { path: "/workspace/src/main.ts" });

    const rules = await loadWorkspaceRules(doc);
    expect(rules).toContain("// Use the public API.");
    expect(rules).toContain("//");
    expect(rules).toContain("// Keep it stable.");
    expect(rules.endsWith("\n")).toBe(true);

    vi.spyOn(vscode.workspace.fs, "readFile").mockRejectedValue(new Error("not available"));
    expect(await loadWorkspaceRules(document("", { languageId: "javascript" }))).toBe("");
    expect(await loadWorkspaceRules(document("", { languageId: "unsupported" }))).toBe("");
  });

  test("renders transformed structured diagnostics and optional contexts within prompt limits", () => {
    const built = buildZetaPrompt(
      request({
        recent_changes: "Earlier edit",
        symbol_outline: "function useThing(): void",
        file_chunks: [
          { file_path: "recent.ts", start_line: 0, end_line: 1, content: "recent buffer" },
        ],
        retrieval_chunks: [
          { file_path: "defs.ts", start_line: 1, end_line: 1, content: "definition context" },
          { file_path: "refs.ts", start_line: 1, end_line: 1, content: "reference context" },
        ],
        editor_diagnostics: [
          {
            line: 1,
            start_offset: 0,
            end_offset: 5,
            severity: "error",
            message: "Prefer stable APIs",
            timestamp: 1,
            code: "TS2345",
          },
        ],
      }),
      {
        workspaceRules: "// prefer stable APIs\n",
        diagnosticMessageTransforms: [
          { pattern: "stable APIs", replacement: "public interfaces" },
          { pattern: "[", replacement: "ignored" },
        ],
        relatedChunkLimit: 1,
        editableTokenBudget: 60,
        contextTokenBudget: 0,
      },
    );

    expect(built).not.toBeNull();
    expect(built?.prompt).toContain("Prefer public interfaces");
    expect(built?.prompt).toContain("TS2345");
    expect(built?.prompt).toContain("function useThing");
    expect(built?.prompt).toContain("Earlier edit");
    expect(built?.prompt).toContain("definition context");
    expect(built?.prompt).not.toContain("reference context");
    expect(built?.prompt).not.toContain("recent buffer");

    const manyLines = Array.from({ length: 50 }, (_, index) => `line ${index}`).join("\n");
    const bounded = buildZetaPrompt(
      request({
        file_contents: manyLines,
        original_file_contents: manyLines,
        cursor_position: manyLines.indexOf("line 25") + "line 25".length,
      }),
      { editableTokenBudget: 1, contextTokenBudget: 0 },
    );
    expect(bounded?.prompt).toContain("line 25");
    expect(bounded?.prompt).not.toContain("line 0");
  });

  test("inline diagnostics leave unrelated comments intact and report rules-file size warnings", () => {
    const prompt = buildZetaPrompt(
      request({
        editor_diagnostics: [
          {
            line: 1,
            start_offset: 0,
            end_offset: 5,
            severity: "warning",
            message: "fix this",
            timestamp: 1,
          },
        ],
      }),
      { inlineDiagnostics: true, diagnosticMarker: "NEEDS FIX", commentPrefix: "//" },
    );
    expect(prompt?.injectedDiagnosticMarker).toBe("NEEDS FIX");
    expect(prompt?.prompt).toContain("// NEEDS FIX (warning): fix this");

    const set = vi.fn();
    const disposable = { dispose: vi.fn() };
    Object.assign(mutableVscode.languages, {
      createDiagnosticCollection: () =>
        ({
          set,
          delete: vi.fn(),
          clear: vi.fn(),
          dispose: vi.fn(),
          name: "rules",
          forEach: vi.fn(),
          get: vi.fn(),
        }) as unknown as vscode.DiagnosticCollection,
    });
    const rulesDocument = document("rules content", {
      path: "/workspace/.vscode/nes-typescript.md",
    });
    Object.assign(mutableVscode.workspace, {
      textDocuments: [rulesDocument],
      onDidOpenTextDocument: () => disposable,
      onDidChangeTextDocument: () => disposable,
      onDidCloseTextDocument: () => disposable,
      onDidChangeConfiguration: () => disposable,
    });
    Object.defineProperty(mutableVscode.window, "visibleTextEditors", {
      configurable: true,
      value: [],
    });
    vi.stubGlobal("__vscodeMockConfiguration", { rulesMaxChars: 3 });
    const rulesDiagnostics = new RulesDiagnostics();
    expect(set).toHaveBeenCalledWith(rulesDocument.uri, [
      expect.objectContaining({
        message: "Language instructions exceed the 3 character limit.",
        severity: vscode.DiagnosticSeverity.Warning,
      }),
    ]);
    rulesDiagnostics.dispose();
  });
});
