import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { AutocompleteResult } from "~/api/schemas.ts";
import { InlineEditProvider } from "~/editor/inline-edit-provider.ts";
import { JumpEditManager } from "~/editor/jump-edit-manager.ts";
import { registerInlineCompletionItemProviderWithMetadata } from "~/editor/proposed-inline-edit.ts";
import { continuationDocument } from "../fixtures/continuation-document.ts";

const providers: InlineEditProvider[] = [];
const jumpManagers: JumpEditManager[] = [];
const originalDiagnostics = vscode.languages.getDiagnostics;
const originalWritable = Object.getOwnPropertyDescriptor(
  vscode.workspace.fs,
  "isWritableFileSystem",
);

function configure(values: Record<string, unknown> = {}): void {
  (
    globalThis as typeof globalThis & { __vscodeMockConfiguration?: Record<string, unknown> }
  ).__vscodeMockConfiguration = { maxContextFiles: 0, outlineSymbols: 0, ...values };
}

function createProvider(results: AutocompleteResult[]) {
  const manager = new JumpEditManager();
  const api = { getAutocomplete: vi.fn().mockResolvedValue(results) };
  const provider = new InlineEditProvider(
    {
      getOriginalContent: () => undefined,
      wasRecentMultiLineSelection: () => false,
      wasRecentBulkChange: () => false,
      getEditDiffHistory: () => [],
      getUserActions: () => [],
      getRecentContextFiles: () => [],
    } as never,
    manager,
    api as never,
  );
  providers.push(provider);
  jumpManagers.push(manager);
  return { api, manager, provider };
}

function selectionAt(position: vscode.Position): vscode.Selection {
  return Object.assign(new vscode.Selection(position, position), {
    start: position,
    end: position,
    isEmpty: true,
  });
}

function activateEditor(document: vscode.TextDocument, position: vscode.Position) {
  const editor = {
    document,
    selection: selectionAt(position),
    selections: [] as vscode.Selection[],
    setDecorations: vi.fn(),
  } as unknown as vscode.TextEditor;
  const moveTo = (next: vscode.Position) => {
    const selection = selectionAt(next);
    editor.selection = selection;
    editor.selections = [selection];
  };
  moveTo(position);
  (vscode.window as unknown as { activeTextEditor: vscode.TextEditor }).activeTextEditor = editor;
  return { editor, moveTo };
}

function invokeContext(
  selectedCompletionInfo?: vscode.SelectedCompletionInfo,
): vscode.InlineCompletionContext {
  return {
    triggerKind: vscode.InlineCompletionTriggerKind.Invoke,
    selectedCompletionInfo,
  };
}

const token = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose() {} }),
} as vscode.CancellationToken;

async function provideWithFakeDebounce(
  provider: InlineEditProvider,
  document: vscode.TextDocument,
  position: vscode.Position,
  context = invokeContext(),
) {
  const pending = provider.provideInlineCompletionItems(document, position, context, token);
  await vi.advanceTimersByTimeAsync(100);
  return pending;
}

function proposedJumpResult(text: string): AutocompleteResult {
  return {
    id: "distant-proposal",
    startIndex: text.indexOf("target"),
    endIndex: text.indexOf("target") + "target".length,
    completion: "replacement",
    confidence: 0.8,
  };
}

beforeEach(() => {
  vscode.languages.getDiagnostics = () => [];
  Object.defineProperty(vscode.workspace.fs, "isWritableFileSystem", {
    configurable: true,
    value: () => true,
  });
});

async function prepareProposedJump() {
  configure({ useCopilotStyleNextEditPresentation: true });
  registerInlineCompletionItemProviderWithMetadata([], {} as never, {}).dispose();
  const text = ["cursor", "", "", "", "", "visual anchor", "target", "tail"].join("\n");
  const { document, update } = continuationDocument(text);
  const position = new vscode.Position(0, 0);
  const active = activateEditor(document, position);
  const { provider, manager } = createProvider([proposedJumpResult(text)]);
  const pending = provider.provideInlineCompletionItems(document, position, invokeContext(), token);
  await vi.advanceTimersByTimeAsync(100);
  const completion = await pending;
  return { document, update, active, provider, manager, completion };
}

afterEach(() => {
  providers.splice(0).forEach((provider) => provider.dispose());
  jumpManagers.splice(0).forEach((manager) => manager.dispose());
  configure();
  registerInlineCompletionItemProviderWithMetadata([], {} as never, {}).dispose();
  (vscode.window as unknown as { activeTextEditor: undefined }).activeTextEditor = undefined;
  vscode.languages.getDiagnostics = originalDiagnostics;
  if (originalWritable) {
    Object.defineProperty(vscode.workspace.fs, "isWritableFileSystem", originalWritable);
  } else {
    Reflect.deleteProperty(vscode.workspace.fs, "isWritableFileSystem");
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("provider lifecycle behavior contract", () => {
  test.each([
    ["target line", 6],
    ["preceding visual-anchor line", 5],
  ])("refreshes once after proposed jump arrival at the %s", async (_label, landingLine) => {
    vi.useFakeTimers();
    const { document, active, provider, manager, completion } = await prepareProposedJump();
    const trigger = vi
      .spyOn(vscode.commands, "executeCommand")
      .mockResolvedValue(undefined)
      .mockClear();
    const setPending = vi.spyOn(manager, "setPendingJumpEdit");

    expect(completion?.items).toHaveLength(1);
    expect(completion?.items[0]).toMatchObject({
      isInlineEdit: true,
      showInlineEditMenu: true,
      correlationId: "distant-proposal",
    });
    expect(setPending).not.toHaveBeenCalled();

    const landing = new vscode.Position(landingLine, 0);
    active.moveTo(landing);
    await provider.handleCursorMove(document, landing);
    await vi.advanceTimersByTimeAsync(0);
    await provider.handleCursorMove(document, landing);
    await vi.advanceTimersByTimeAsync(0);

    expect(
      trigger.mock.calls.filter(([command]) => command === "editor.action.inlineSuggest.trigger"),
    ).toHaveLength(1);
  });

  test.each(["moved", "document-edited", "stale-editor"] as const)(
    "cancels the scheduled proposed-jump refresh when the landing becomes %s",
    async (change) => {
      vi.useFakeTimers();
      const { document, update, active, provider } = await prepareProposedJump();
      const trigger = vi
        .spyOn(vscode.commands, "executeCommand")
        .mockResolvedValue(undefined)
        .mockClear();
      const landing = new vscode.Position(6, 0);
      active.moveTo(landing);
      await provider.handleCursorMove(document, landing);

      if (change === "moved") {
        const elsewhere = new vscode.Position(2, 0);
        active.moveTo(elsewhere);
        await provider.handleCursorMove(document, elsewhere);
      } else if (change === "document-edited") {
        update(`${document.getText()}\nchanged`);
        await provider.handleCursorMove(document, landing);
      } else {
        const { document: otherDocumentBase } = continuationDocument("other file");
        const otherDocument = {
          ...otherDocumentBase,
          uri: vscode.Uri.file("/workspace/other.ts"),
          fileName: "/workspace/other.ts",
        } as vscode.TextDocument;
        (active.editor as unknown as { document: vscode.TextDocument }).document = otherDocument;
      }

      await vi.advanceTimersByTimeAsync(0);
      expect(
        trigger.mock.calls.filter(([command]) => command === "editor.action.inlineSuggest.trigger"),
      ).toHaveLength(0);
    },
  );

  test("rejects selected-completion candidates unless range and text remain compatible", async () => {
    configure();
    const rangePrototype = Object.getPrototypeOf(
      new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)),
    ) as {
      isEqual?: (other: vscode.Range) => boolean;
    };
    const priorIsEqual = rangePrototype.isEqual;
    rangePrototype.isEqual = function (other) {
      const start = this as unknown as vscode.Range;
      return (
        start.start.line === other.start.line &&
        start.start.character === other.start.character &&
        start.end.line === other.end.line &&
        start.end.character === other.end.character
      );
    };
    try {
      const { document } = continuationDocument("name");
      const position = new vscode.Position(0, 4);
      activateEditor(document, position);
      const candidate: AutocompleteResult = {
        id: "selected-compatibility",
        startIndex: 4,
        endIndex: 4,
        completion: "next",
        confidence: 0.8,
      };

      const incompatible = createProvider([candidate]).provider;
      const mismatched = await incompatible.provideInlineCompletionItems(
        document,
        position,
        invokeContext({
          range: new vscode.Range(position, position),
          text: "other",
        }),
        token,
      );
      expect(mismatched).toBeUndefined();

      const compatible = createProvider([candidate]).provider;
      const matched = await compatible.provideInlineCompletionItems(
        document,
        position,
        invokeContext({
          range: new vscode.Range(position, position),
          text: "ne",
        }),
        token,
      );
      expect(matched?.items).toHaveLength(1);
    } finally {
      if (priorIsEqual) rangePrototype.isEqual = priorIsEqual;
      else delete rangePrototype.isEqual;
    }
  });

  test("advances an accepted inline edit to the next suggestion at its shifted range", async () => {
    vi.useFakeTimers();
    configure({ useCopilotStyleNextEditPresentation: true });
    registerInlineCompletionItemProviderWithMetadata([], {} as never, {}).dispose();
    const { document, update } = continuationDocument("abcd");
    const initialPosition = new vscode.Position(0, 0);
    const { editor } = activateEditor(document, initialPosition);
    const first: AutocompleteResult = {
      id: "first-insertion",
      startIndex: 0,
      endIndex: 0,
      completion: "HELLO",
      confidence: 0.8,
    };
    const second: AutocompleteResult = {
      id: "second-insertion",
      startIndex: 2,
      endIndex: 2,
      completion: "!",
      confidence: 0.8,
    };
    const { provider } = createProvider([first, second]);
    const firstList = await provideWithFakeDebounce(provider, document, initialPosition);
    const firstItem = firstList?.items[0];
    expect(firstItem?.insertText).toBe("HELLO");

    const arguments_ = firstItem?.command?.arguments ?? [];
    provider.handleInlineAccept(arguments_[0] as never, arguments_[1] as never);
    update("HELLOabcd");
    const nextPosition = new vscode.Position(0, 5);
    editor.selection = selectionAt(nextPosition);
    editor.selections = [editor.selection];

    const secondList = await provider.provideInlineCompletionItems(
      document,
      nextPosition,
      invokeContext(),
      token,
    );
    expect(secondList?.items).toHaveLength(1);
    expect(secondList?.items[0]?.insertText).toBe("!");
    expect(secondList?.items[0]?.range?.start).toEqual(new vscode.Position(0, 7));
  });

  test("requests another completion after accepting the final queued suggestion", async () => {
    vi.useFakeTimers();
    configure();
    const { document } = continuationDocument("abcd");
    const position = new vscode.Position(0, 0);
    activateEditor(document, position);
    const onlySuggestion: AutocompleteResult = {
      id: "final-insertion",
      startIndex: 0,
      endIndex: 0,
      completion: "next",
      confidence: 0.8,
    };
    const { provider } = createProvider([onlySuggestion]);
    const list = await provideWithFakeDebounce(provider, document, position);
    const item = list?.items[0];
    expect(item?.insertText).toBe("next");

    const trigger = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    const arguments_ = item?.command?.arguments ?? [];
    provider.handleInlineAccept(arguments_[0] as never, arguments_[1] as never);

    expect(
      trigger.mock.calls.filter(([command]) => command === "editor.action.inlineSuggest.trigger"),
    ).toHaveLength(1);
  });

  test("retains a distant edit after the first accepted split segment", async () => {
    vi.useFakeTimers();
    configure({ useCopilotStyleNextEditPresentation: true });
    registerInlineCompletionItemProviderWithMetadata([], {} as never, {}).dispose();
    const original = [
      "cursor",
      "keep one",
      "keep two",
      "keep three",
      "keep four",
      "target = old;",
      "tail",
    ].join("\n");
    const replacement = original.replace("cursor", "cursor!").replace("old", "new");
    const { document, update } = continuationDocument(original);
    const position = new vscode.Position(0, 0);
    const { editor } = activateEditor(document, position);
    const wholeEdit: AutocompleteResult = {
      id: "inline-then-jump",
      startIndex: 0,
      endIndex: original.length,
      completion: replacement,
      confidence: 0.8,
    };
    const { api, provider } = createProvider([wholeEdit]);
    const firstList = await provideWithFakeDebounce(provider, document, position);
    const firstItem = firstList?.items[0];
    expect(firstItem?.insertText).toBe("!");

    const trigger = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    const arguments_ = firstItem?.command?.arguments ?? [];
    provider.handleInlineAccept(arguments_[0] as never, arguments_[1] as never);
    const acceptedRange = firstItem?.range as vscode.Range;
    const acceptedStart = document.offsetAt(acceptedRange.start);
    const acceptedEnd = document.offsetAt(acceptedRange.end);
    const afterFirstAcceptance =
      original.slice(0, acceptedStart) +
      (firstItem?.insertText as string) +
      original.slice(acceptedEnd);
    update(afterFirstAcceptance);
    editor.selection = selectionAt(position);
    editor.selections = [editor.selection];

    const nextList = await provider.provideInlineCompletionItems(
      document,
      position,
      invokeContext(),
      token,
    );
    expect(
      trigger.mock.calls.filter(([command]) => command === "editor.action.inlineSuggest.trigger"),
    ).toHaveLength(1);
    expect(api.getAutocomplete).toHaveBeenCalledTimes(1);
    expect(nextList?.items).toHaveLength(1);
    expect(nextList?.items[0]).toMatchObject({
      insertText: "new",
      isInlineEdit: true,
      showInlineEditMenu: true,
    });
    expect(nextList?.items[0]?.range?.start).toEqual(new vscode.Position(5, "target = ".length));
  });
});
