import * as vscode from "vscode";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import type { AutocompleteResult } from "~/api/schemas.ts";
import { classifyEditDisplay } from "~/editor/edit-display-classifier.ts";
import { InlineEditProvider } from "~/editor/inline-edit-provider.ts";
import {
  enableForwardStability,
  markAsProposedInlineEdit,
  registerInlineCompletionItemProviderWithMetadata,
} from "~/editor/proposed-inline-edit.ts";
import { splitEditIntoSegments } from "~/editor/split-edit-segments.ts";
import { continuationDocument } from "./fixtures/continuation-document.ts";

type ProviderInternals = {
  rememberEditableWindow(
    snapshot: { uri: string; version: number; position: vscode.Position; content: string },
    startLine: number,
    endLine: number,
  ): void;
  tryBuildGhostTextExtension(
    snapshot: { uri: string; version: number; position: vscode.Position; content: string },
    document: vscode.TextDocument,
    results: AutocompleteResult[],
  ): AutocompleteResult[] | null;
  getReusableInFlightRequest(
    snapshot: { uri: string; version: number; position: vscode.Position; content: string },
    document: vscode.TextDocument,
  ): unknown;
  buildCompletionItem(
    document: vscode.TextDocument,
    position: vscode.Position,
    result: AutocompleteResult & { cursorTargetOffset?: number },
    proposed?: boolean,
  ): vscode.InlineCompletionList | undefined;
  setSuggestionQueue(uri: string, suggestions: AutocompleteResult[]): void;
  queuedSuggestions: { uri: string; suggestions: AutocompleteResult[] } | null;
  inFlightRequest: unknown;
};

function internals(provider: InlineEditProvider): ProviderInternals {
  return provider as unknown as ProviderInternals;
}

function configure(values: Record<string, unknown> = {}): void {
  (
    globalThis as typeof globalThis & { __vscodeMockConfiguration?: Record<string, unknown> }
  ).__vscodeMockConfiguration = values;
}

const dummyTracker = {
  getOriginalContent: () => undefined,
} as never;

afterEach(() => {
  configure();
  (vscode.window as unknown as { activeTextEditor: undefined }).activeTextEditor = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("editor behavior", () => {
  test("keeps independent changes split and attaches a final newline to its insertion", () => {
    const original = "before\nconst first = 1;\nkeep\nconst second = 2;";
    const replacement = "before\nconst first = 10;\nkeep\nconst second = 20;\n";
    const edit: AutocompleteResult = {
      id: "two-edits-and-newline",
      startIndex: 0,
      endIndex: original.length,
      completion: replacement,
    };

    const segments = splitEditIntoSegments(original, edit);

    expect(segments).toHaveLength(3);
    const finalNewline = segments.find(
      (segment) => segment.startIndex === original.length && segment.endIndex === original.length,
    );
    expect(finalNewline?.completion).toBe("\n");

    let applied = original;
    for (const segment of [...segments].reverse()) {
      applied =
        applied.slice(0, segment.startIndex) + segment.completion + applied.slice(segment.endIndex);
    }
    expect(applied).toBe(replacement);
  });

  test("does not split an edit carrying an explicit cursor target", () => {
    const original = "const first = 1;\nkeep\nconst second = 2;";
    const edit = {
      id: "cursor-targeted",
      startIndex: 0,
      endIndex: original.length,
      completion: "const first = 10;\nkeep\nconst second = 20;",
      cursorTargetOffset: 7,
    } as AutocompleteResult & { cursorTargetOffset: number };

    expect(splitEditIntoSegments(original, edit)).toEqual([edit]);
  });

  test("keeps malformed ranges as one conservative edit", () => {
    const original = "first line\nold tail";
    const edit: AutocompleteResult = {
      id: "truncated-tail",
      startIndex: 0,
      endIndex: original.length + 1,
      completion: "first line\nnew",
    };

    expect(splitEditIntoSegments(original, edit)).toEqual([edit]);
  });

  test("routes before-cursor replacements to jump presentation by default", () => {
    expect(
      classifyEditDisplay({
        cursorLine: 4,
        editStartLine: 4,
        editEndLine: 4,
        cursorOffset: 40,
        startIndex: 36,
        completion: "newName",
        isOnSingleNewlineBoundary: false,
      }),
    ).toEqual({ decision: "JUMP", reason: "before-cursor-single-line" });
  });

  test("registers native metadata when the API is available without proposal configuration", () => {
    configure();
    const registration = vi.spyOn(vscode.languages, "registerInlineCompletionItemProvider");
    const provider = {} as vscode.InlineCompletionItemProvider;

    registerInlineCompletionItemProviderWithMetadata([], provider, {
      groupId: "nesweep",
    }).dispose();

    expect(registration).toHaveBeenCalledExactlyOnceWith([], provider, { groupId: "nesweep" });
  });

  test("reports an actionable setup error when native registration is denied without retrying", () => {
    const registration = vi
      .spyOn(vscode.languages, "registerInlineCompletionItemProvider")
      .mockImplementation(() => {
        throw new Error("inlineCompletionsAdditions proposed API is not available");
      });
    const provider = {} as vscode.InlineCompletionItemProvider;

    expect(() => registerInlineCompletionItemProviderWithMetadata([], provider, {})).toThrow(
      /native inline edit API.*enable-proposed-api.*README/i,
    );
    expect(registration).toHaveBeenCalledExactlyOnceWith([], provider, {});
  });

  test("reports setup guidance when native registration is absent", () => {
    const registration = vscode.languages.registerInlineCompletionItemProvider;
    try {
      Reflect.deleteProperty(vscode.languages, "registerInlineCompletionItemProvider");
      expect(() => registerInlineCompletionItemProviderWithMetadata([], {} as never, {})).toThrow(
        /native inline edit API.*enable-proposed-api.*README/i,
      );
    } finally {
      vscode.languages.registerInlineCompletionItemProvider = registration;
    }
  });

  test("does not hide unrelated provider registration failures", () => {
    const failure = new Error("provider registration failed for another reason");
    const registration = vi
      .spyOn(vscode.languages, "registerInlineCompletionItemProvider")
      .mockImplementation(() => {
        throw failure;
      });

    expect(() =>
      registerInlineCompletionItemProviderWithMetadata(
        [],
        {} as vscode.InlineCompletionItemProvider,
        {},
      ),
    ).toThrow(failure);
    expect(registration).toHaveBeenCalledTimes(1);
  });

  test("marks proposed items and lists for native forward stability", () => {
    const item = { insertText: "replacement" } as vscode.InlineCompletionItem;
    const list = { items: [item] } as vscode.InlineCompletionList;

    expect(
      markAsProposedInlineEdit(item, {
        correlationId: "proposal-1",
        showRange: new vscode.Range(new vscode.Position(1, 0), new vscode.Position(1, 3)),
      }),
    ).toMatchObject({ isInlineEdit: true, showInlineEditMenu: true, correlationId: "proposal-1" });
    expect(enableForwardStability(list)).toMatchObject({ enableForwardStability: true });
  });

  test("cancels context-exit refresh on return and triggers at most once per window", async () => {
    vi.useFakeTimers();
    configure({ retriggerOnContextExit: true, contextExitRetriggerDebounceMs: 10 });
    const { document } = continuationDocument("a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n");
    const position = new vscode.Position(0, 0);
    const editor = {
      document,
      selection: new vscode.Selection(position, position),
    } as unknown as vscode.TextEditor;
    (vscode.window as unknown as { activeTextEditor: vscode.TextEditor }).activeTextEditor = editor;
    const provider = new InlineEditProvider(dummyTracker, {} as never, {} as never);
    const privateProvider = internals(provider);
    privateProvider.rememberEditableWindow(
      {
        uri: document.uri.toString(),
        version: document.version,
        position,
        content: document.getText(),
      },
      3,
      7,
    );
    const trigger = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);

    editor.selection = new vscode.Selection(new vscode.Position(9, 0), new vscode.Position(9, 0));
    await provider.handleCursorMove(document, new vscode.Position(9, 0));
    editor.selection = new vscode.Selection(new vscode.Position(4, 0), new vscode.Position(4, 0));
    await provider.handleCursorMove(document, new vscode.Position(4, 0));
    await vi.advanceTimersByTimeAsync(20);
    expect(trigger).not.toHaveBeenCalled();

    editor.selection = new vscode.Selection(new vscode.Position(9, 0), new vscode.Position(9, 0));
    await provider.handleCursorMove(document, new vscode.Position(9, 0));
    await vi.advanceTimersByTimeAsync(20);
    await provider.handleCursorMove(document, new vscode.Position(9, 0));
    await vi.advanceTimersByTimeAsync(20);
    expect(trigger).toHaveBeenCalledExactlyOnceWith("editor.action.inlineSuggest.trigger");
    provider.dispose();
  });

  test("extends only a matching typed prefix and leaves the remainder at the live cursor", () => {
    const { document, update } = continuationDocument("const value = ");
    const cursor = document.getText().length;
    const snapshot = {
      uri: document.uri.toString(),
      version: document.version,
      position: new vscode.Position(0, cursor),
      content: document.getText(),
    };
    const result: AutocompleteResult = {
      id: "prefix-extension",
      startIndex: cursor,
      endIndex: cursor,
      completion: "foobar",
    };
    update("const value = foo");
    const liveCursor = new vscode.Position(0, document.getText().length);
    const editor = {
      document,
      selection: new vscode.Selection(liveCursor, liveCursor),
    } as unknown as vscode.TextEditor;
    (vscode.window as unknown as { activeTextEditor: vscode.TextEditor }).activeTextEditor = editor;
    const provider = new InlineEditProvider(dummyTracker, {} as never, {} as never);

    expect(internals(provider).tryBuildGhostTextExtension(snapshot, document, [result])).toEqual([
      {
        ...result,
        startIndex: document.getText().length,
        endIndex: document.getText().length,
        completion: "bar",
      },
    ]);
    update("const value = fooz");
    expect(internals(provider).tryBuildGhostTextExtension(snapshot, document, [result])).toBeNull();
    provider.dispose();
  });

  test("reuses an in-flight request for identifier typing but not punctuation", () => {
    const { document, update } = continuationDocument("const value = ");
    const original = document.getText();
    const originalPosition = new vscode.Position(0, original.length);
    const provider = new InlineEditProvider(dummyTracker, {} as never, {} as never);
    const privateProvider = internals(provider);
    const controller = new AbortController();
    privateProvider.inFlightRequest = {
      response: Promise.resolve([]),
      controller,
      uri: document.uri.toString(),
      snapshot: {
        uri: document.uri.toString(),
        version: document.version,
        position: originalPosition,
        content: original,
      },
    };

    update(`${original}x`);
    expect(
      privateProvider.getReusableInFlightRequest(
        {
          uri: document.uri.toString(),
          version: document.version,
          position: new vscode.Position(0, original.length + 1),
          content: document.getText(),
        },
        document,
      ),
    ).toBe(privateProvider.inFlightRequest);

    update(`${original}x.`);
    expect(
      privateProvider.getReusableInFlightRequest(
        {
          uri: document.uri.toString(),
          version: document.version,
          position: new vscode.Position(0, original.length + 2),
          content: document.getText(),
        },
        document,
      ),
    ).toBeNull();
    provider.dispose();
  });

  test("uses plain text for proposed edits and restores cursor before shifting queued edits", () => {
    const { document } = continuationDocument("abcdefghi");
    const position = new vscode.Position(0, 3);
    const editor = {
      document,
      selection: new vscode.Selection(position, position),
    } as unknown as vscode.TextEditor;
    (vscode.window as unknown as { activeTextEditor: vscode.TextEditor }).activeTextEditor = editor;
    const provider = new InlineEditProvider(dummyTracker, {} as never, {} as never);
    const first: AutocompleteResult & { cursorTargetOffset: number } = {
      id: "targeted",
      startIndex: 1,
      endIndex: 4,
      completion: "WXYZ",
      cursorTargetOffset: 2,
    };
    const later: AutocompleteResult = {
      id: "later",
      startIndex: 6,
      endIndex: 7,
      completion: "Q",
    };
    const itemList = internals(provider).buildCompletionItem(document, position, first, true)!;
    expect(itemList.items[0]?.insertText).toBe("WXYZ");
    internals(provider).setSuggestionQueue(document.uri.toString(), [later]);

    provider.handleInlineAccept({ id: first.id } as never, { ...first });

    expect(editor.selection.active).toEqual(new vscode.Position(0, 3));
    expect(internals(provider).queuedSuggestions?.suggestions).toEqual([
      { ...later, startIndex: 7, endIndex: 8 },
    ]);
    provider.dispose();
  });
});
