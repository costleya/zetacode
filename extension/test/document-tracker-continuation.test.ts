import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import * as vscode from "vscode";

import { DocumentTracker } from "~/telemetry/document-tracker.ts";
import { continuationDocument } from "./fixtures/continuation-document.ts";

const trackers: DocumentTracker[] = [];

function setActiveDocument(document: vscode.TextDocument | undefined) {
  (
    vscode.window as unknown as { activeTextEditor: vscode.TextEditor | undefined }
  ).activeTextEditor = document ? ({ document } as vscode.TextEditor) : undefined;
}

function enterFixture(
  insertedText = "\n  ",
  rangeLength = 0,
  reason?: vscode.TextDocumentChangeReason,
) {
  const before = "function demo() {";
  const fixture = continuationDocument(`${before}${insertedText}\n}`);
  const tracker = new DocumentTracker();
  trackers.push(tracker);
  setActiveDocument(fixture.document);
  tracker.setActiveFile(fixture.document);
  const start = new vscode.Position(0, before.length);
  const change: vscode.TextDocumentContentChangeEvent = {
    range: new vscode.Range(start, new vscode.Position(0, before.length + rangeLength)),
    rangeOffset: before.length,
    rangeLength,
    text: insertedText,
  };
  const event = {
    document: fixture.document,
    contentChanges: [change],
    reason,
  } as vscode.TextDocumentChangeEvent;
  tracker.trackChange(event);
  return {
    ...fixture,
    tracker,
    event,
    position: fixture.document.positionAt(before.length + insertedText.length),
  };
}

afterEach(() => {
  trackers.splice(0).forEach((tracker) => tracker.dispose());
  setActiveDocument(undefined);
  vi.restoreAllMocks();
});

describe("DocumentTracker continuation eligibility", () => {
  test.each(["\n", "\n  ", "\r\n\t"])(
    "accepts a pure Enter insertion %j at its resulting cursor",
    (text) => {
      const { tracker, document, position } = enterFixture(text);

      expect(tracker.hasRecentNewlineInsertion(document, position)).toBe(true);
    },
  );

  test.each(["x", "  ", "\n\n", "\n  code", "pasted\n  "])(
    "rejects non-Enter and bulk insertion %j",
    (text) => {
      const { tracker, document, position } = enterFixture(text);

      expect(tracker.hasRecentNewlineInsertion(document, position)).toBe(false);
    },
  );

  test.each([vscode.TextDocumentChangeReason.Undo, vscode.TextDocumentChangeReason.Redo])(
    "rejects undo/redo event reason %s",
    (reason) => {
      const { tracker, document, position } = enterFixture("\n  ", 0, reason);

      expect(tracker.hasRecentNewlineInsertion(document, position)).toBe(false);
    },
  );

  test("rejects replacing a selection with a newline", () => {
    const { tracker, document, position } = enterFixture("\n  ", 1);

    expect(tracker.hasRecentNewlineInsertion(document, position)).toBe(false);
  });

  test("rejects a multiple-change event even if one change resembles Enter", () => {
    const { tracker, document, position, event } = enterFixture();
    tracker.trackChange({
      ...event,
      contentChanges: [...event.contentChanges, ...event.contentChanges],
    });

    expect(tracker.hasRecentNewlineInsertion(document, position)).toBe(false);
  });

  test("requires the same document, version, and exact resulting cursor", () => {
    const { tracker, document, position, update } = enterFixture();
    expect(tracker.hasRecentNewlineInsertion(document, new vscode.Position(1, 0))).toBe(false);
    const otherDocument = {
      ...document,
      uri: vscode.Uri.file("/workspace/other.ts"),
    } as vscode.TextDocument;
    expect(tracker.hasRecentNewlineInsertion(otherDocument, position)).toBe(false);

    update(document.getText());

    expect(tracker.hasRecentNewlineInsertion(document, position)).toBe(false);
  });

  test("a later ordinary edit invalidates the Enter candidate", () => {
    const { tracker, document, position, event } = enterFixture();
    tracker.trackChange({
      ...event,
      contentChanges: [{ ...event.contentChanges[0]!, text: "x" }],
    });

    expect(tracker.hasRecentNewlineInsertion(document, position)).toBe(false);
  });

  test("preserves Enter eligibility across metadata-only autosave events until the next edit", () => {
    const { tracker, document, position, event, update } = enterFixture();
    expect(tracker.hasRecentNewlineInsertion(document, position)).toBe(true);

    tracker.trackChange({ ...event, contentChanges: [] });

    expect(tracker.hasRecentNewlineInsertion(document, position)).toBe(true);

    const offset = document.offsetAt(position);
    update(document.getText().slice(0, offset) + "x" + document.getText().slice(offset));
    tracker.trackChange({
      document,
      contentChanges: [
        {
          range: new vscode.Range(position, position),
          rangeOffset: offset,
          rangeLength: 0,
          text: "x",
        },
      ],
    } as unknown as vscode.TextDocumentChangeEvent);

    expect(tracker.hasRecentNewlineInsertion(document, new vscode.Position(1, 3))).toBe(false);
  });

  test("expires a remembered Enter after ten seconds", () => {
    let now = 100_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { tracker, document, position } = enterFixture();
    expect(tracker.hasRecentNewlineInsertion(document, position)).toBe(true);
    now += 10_001;

    expect(tracker.hasRecentNewlineInsertion(document, position)).toBe(false);
  });

  test("moving away and returning does not resurrect the Enter candidate", () => {
    const { tracker, document, position } = enterFixture();
    tracker.trackCursorMovement(document, new vscode.Position(0, 0));
    tracker.trackCursorMovement(document, position);

    expect(tracker.hasRecentNewlineInsertion(document, position)).toBe(false);
  });

  test("switching files and returning invalidates the Enter candidate", () => {
    const { tracker, document, position } = enterFixture();
    const other = continuationDocument().document;
    tracker.setActiveFile({
      ...other,
      fileName: "/workspace/other.ts",
      uri: vscode.Uri.file("/workspace/other.ts"),
    });
    tracker.setActiveFile(document);

    expect(tracker.hasRecentNewlineInsertion(document, position)).toBe(false);
  });
});
