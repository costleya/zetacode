import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { AutocompleteResult } from "~/api/schemas.ts";
import { JumpEditManager } from "~/editor/jump-edit-manager.ts";
import {
  createHighlightedBoxDecoration,
  createHighlightedBoxDecorationMultiline,
} from "~/editor/syntax-highlight-renderer.ts";

vi.mock("~/editor/syntax-highlight-renderer.ts", () => ({
  createHighlightedBoxDecoration: vi.fn(),
  createHighlightedBoxDecorationMultiline: vi.fn(),
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function makeDocument(text: string): vscode.TextDocument {
  const lines = text.split("\n");
  const offsetAt = (position: vscode.Position) => {
    let offset = 0;
    for (let line = 0; line < position.line; line++) offset += (lines[line]?.length ?? 0) + 1;
    return offset + position.character;
  };
  return {
    uri: vscode.Uri.file("/workspace/preview-rejection.ts"),
    version: 1,
    lineCount: lines.length,
    languageId: "typescript",
    getText: (range?: vscode.Range) =>
      range ? text.slice(offsetAt(range.start), offsetAt(range.end)) : text,
    offsetAt,
    positionAt: (offset: number) => {
      let remaining = offset;
      for (let line = 0; line < lines.length; line++) {
        const lineLength = lines[line]?.length ?? 0;
        if (remaining <= lineLength) return new vscode.Position(line, remaining);
        remaining -= lineLength + 1;
      }
      const lastLine = Math.max(0, lines.length - 1);
      return new vscode.Position(lastLine, lines[lastLine]?.length ?? 0);
    },
    lineAt: (line: number) => {
      const lineText = lines[line] ?? "";
      return {
        text: lineText,
        range: new vscode.Range(
          new vscode.Position(line, 0),
          new vscode.Position(line, lineText.length),
        ),
      };
    },
  } as vscode.TextDocument;
}

function makeEdit(document: vscode.TextDocument): AutocompleteResult {
  const text = document.getText();
  return {
    id: "concurrent-preview-renderers",
    startIndex: 0,
    endIndex: text.length,
    completion: "bravo\nunchanged\nsigma",
    confidence: 0.8,
  };
}

function makeEditor(document: vscode.TextDocument): vscode.TextEditor {
  return {
    document,
    options: { tabSize: 4 },
    selection: { active: new vscode.Position(0, 0) },
    setDecorations: vi.fn(),
  } as unknown as vscode.TextEditor;
}

async function nextEventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

let renderers: Deferred<vscode.DecorationOptions>[];

beforeEach(() => {
  renderers = [];
  vi.clearAllMocks();
  vi.mocked(createHighlightedBoxDecoration).mockImplementation(() => {
    const next = renderers.shift();
    if (!next) throw new Error("No single-line render was queued");
    return next.promise;
  });
  vi.mocked(createHighlightedBoxDecorationMultiline).mockImplementation(() => {
    throw new Error("Unexpected multiline render");
  });
});

afterEach(() => {
  (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = undefined;
  vi.restoreAllMocks();
});

describe("jump preview renderer rejection parity", () => {
  test.each(["first renderer fails", "first renderer becomes stale"] as const)(
    "observes a later rejection while the %s",
    async (firstOutcome) => {
      const document = makeDocument("alpha\nunchanged\nomega");
      const editor = makeEditor(document);
      (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = editor;

      const first = deferred<vscode.DecorationOptions>();
      const second = deferred<vscode.DecorationOptions>();
      renderers.push(first, second);
      const manager = new JumpEditManager();
      const completed = vi.fn();
      const finished = deferred<string>();
      completed.mockImplementation((outcome: string) => finished.resolve(outcome));
      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
      process.on("unhandledRejection", onUnhandledRejection);

      try {
        manager.setPendingJumpEdit(document, makeEdit(document), completed);
        expect(createHighlightedBoxDecoration).toHaveBeenCalledTimes(2);

        second.reject(new Error("second highlight failed"));
        await nextEventLoopTurn();
        expect(unhandledRejections).toEqual([]);
        expect(completed).not.toHaveBeenCalled();

        if (firstOutcome === "first renderer fails") {
          first.reject(new Error("first highlight failed"));
          expect(await finished.promise).toBe("error");
        } else {
          manager.clearJumpEdit();
          first.resolve({ range: new vscode.Range(0, 0, 0, 0) });
          expect(await finished.promise).toBe("cancelled");
        }

        await nextEventLoopTurn();
        expect(unhandledRejections).toEqual([]);
        expect(completed).toHaveBeenCalledTimes(1);
      } finally {
        process.off("unhandledRejection", onUnhandledRejection);
        manager.dispose();
      }

      expect(completed).toHaveBeenCalledTimes(1);
    },
  );
});
