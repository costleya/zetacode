import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { DocumentTracker } from "~/telemetry/document-tracker.ts";
import { shouldCoalesce } from "~/telemetry/edit-merger.ts";

type TrackerDocument = vscode.TextDocument & { setText(value: string): void };

function makeDocument(path: string, initialText: string): TrackerDocument {
  let text = initialText;
  const uri = vscode.Uri.file(path);
  const offsetAt = (position: vscode.Position) => {
    const lines = text.split("\n");
    return (
      lines.slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) +
      position.character
    );
  };
  return {
    uri,
    fileName: path,
    isDirty: false,
    version: 1,
    languageId: "typescript",
    getText: (range?: vscode.Range) =>
      range ? text.slice(offsetAt(range.start), offsetAt(range.end)) : text,
    setText: (value: string) => {
      text = value;
    },
    lineAt: (line: number) => ({ text: text.split(/\r?\n/)[line] ?? "" }),
    positionAt: (offset: number) => {
      const prefix = text.slice(0, offset);
      const lines = prefix.split("\n");
      return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
    },
    offsetAt,
  } as unknown as TrackerDocument;
}

function replaceText(
  tracker: DocumentTracker,
  document: TrackerDocument,
  line: number,
  character: number,
  replacedLength: number,
  insertedText: string,
): void {
  const start = { line, character };
  const end = { line, character: character + replacedLength };
  const rangeOffset = document.offsetAt(start as vscode.Position);
  const before = document.getText();
  document.setText(
    before.slice(0, rangeOffset) + insertedText + before.slice(rangeOffset + replacedLength),
  );
  tracker.trackChange({
    document,
    contentChanges: [
      {
        range: { start, end, isEmpty: replacedLength === 0 },
        rangeOffset,
        rangeLength: replacedLength,
        text: insertedText,
      },
    ],
  } as unknown as vscode.TextDocumentChangeEvent);
}

function makeContext(values = new Map<string, unknown>()) {
  const update = vi.fn(async (key: string, value: unknown) => {
    if (value === undefined) values.delete(key);
    else values.set(key, value);
  });
  const get = vi.fn((key: string) => values.get(key));
  return {
    values,
    get,
    update,
    context: { workspaceState: { get, update } } as unknown as vscode.ExtensionContext,
  };
}

const workspaceUri = vscode.Uri.file("/workspace");

beforeEach(() => {
  (vscode.workspace as { textDocuments: readonly vscode.TextDocument[] }).textDocuments = [];
  vi.spyOn(vscode.workspace, "getWorkspaceFolder").mockImplementation((uri) =>
    uri.fsPath.startsWith("/workspace")
      ? ({ uri: workspaceUri, name: "workspace", index: 0 } as vscode.WorkspaceFolder)
      : undefined,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("DocumentTracker rebuild contract", () => {
  test("captures a real edit and action but ignores an empty change", () => {
    const path = "/workspace/source.ts";
    const document = makeDocument(path, "let n = 1\n");
    (vscode.workspace as { textDocuments: readonly vscode.TextDocument[] }).textDocuments = [
      document,
    ];
    const tracker = new DocumentTracker();
    tracker.setActiveFile(document);

    tracker.trackChange({
      document,
      contentChanges: [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
            isEmpty: true,
          },
          rangeOffset: 0,
          rangeLength: 0,
          text: "",
        },
      ],
    } as unknown as vscode.TextDocumentChangeEvent);
    expect(tracker.getEditDiffHistory()).toEqual([]);
    expect(tracker.getUserActions(path)).toEqual([]);

    document.setText("let n = 2\n");
    tracker.trackChange({
      document,
      contentChanges: [
        {
          range: {
            start: { line: 0, character: 8 },
            end: { line: 0, character: 9 },
            isEmpty: false,
          },
          rangeOffset: 8,
          rangeLength: 1,
          text: "2",
        },
      ],
    } as unknown as vscode.TextDocumentChangeEvent);

    expect(tracker.getEditDiffHistory()).toHaveLength(1);
    expect(tracker.getEditDiffHistory()[0]?.diff).toContain("\n-1");
    expect(tracker.getEditDiffHistory()[0]?.diff).toContain("\n+2");
    expect(tracker.getUserActions(path)).toMatchObject([
      { action_type: "INSERT_CHAR", file_path: path, line_number: 0, offset: 9 },
    ]);
    tracker.dispose();
  });

  test("flushes metadata without file contents and restores current disk bytes", async () => {
    const path = "/workspace/notes.ts";
    const document = makeDocument(path, "first\nsecond\n");
    const storage = makeContext();
    vi.spyOn(vscode.workspace.fs, "stat").mockResolvedValue({
      type: 1 as vscode.FileType,
      ctime: 0,
      mtime: 1_700_000_000_000,
      size: document.getText().length,
    });

    const tracker = new DocumentTracker(storage.context);
    await tracker.trackFileVisit(document);
    tracker.trackCursorMovement(document, { line: 1, character: 3 } as vscode.Position);
    await tracker.flush();

    const saved = storage.values.get("sweep.tracker.v2") as {
      version: number;
      recentFiles: Array<Record<string, unknown>>;
      cursorPositions: unknown[];
      userActions: unknown[];
    };
    expect(saved.version).toBe(2);
    expect(saved.recentFiles).toEqual([
      expect.objectContaining({ uri: path, mtime: 1_700_000_000 }),
    ]);
    expect(saved.recentFiles[0]).not.toHaveProperty("content");
    expect(saved.cursorPositions).toHaveLength(1);
    expect(saved.userActions).toHaveLength(1);

    vi.spyOn(vscode.workspace.fs, "readFile").mockResolvedValue(
      new TextEncoder().encode("updated on disk\n"),
    );
    const restored = new DocumentTracker(storage.context);
    await restored.flush();
    expect(restored.getRecentContextFiles("", 10)).toEqual([
      expect.objectContaining({
        filepath: "notes.ts",
        content: "updated on disk\n",
        cursorLine: 1,
      }),
    ]);
    tracker.dispose();
    restored.dispose();
  });

  test("does not let a delayed restore resurrect a deleted file", async () => {
    const path = "/workspace/deleted.ts";
    const storage = makeContext(
      new Map([
        [
          "sweep.tracker.v2",
          {
            version: 2,
            recentFiles: [{ uri: path, timestamp: 10 }],
            recentFileEditBuckets: [],
            userActions: [],
            cursorPositions: [],
          },
        ],
      ]),
    );
    vi.spyOn(vscode.workspace.fs, "stat").mockResolvedValue({
      type: 1 as vscode.FileType,
      ctime: 0,
      mtime: 1_700_000_000_000,
      size: 0,
    });
    let completeRead!: (bytes: Uint8Array) => void;
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    vi.spyOn(vscode.workspace.fs, "readFile").mockImplementation(() => {
      markReadStarted();
      return new Promise((resolve) => (completeRead = resolve));
    });

    const tracker = new DocumentTracker(storage.context);
    await readStarted;
    tracker.forgetFile(vscode.Uri.file(path));
    completeRead(new TextEncoder().encode("stale disk contents\n"));
    await tracker.flush();

    expect(tracker.getRecentContextFiles("", 10)).toEqual([]);
    expect(
      (storage.values.get("sweep.tracker.v2") as { recentFiles: unknown[] }).recentFiles,
    ).toEqual([]);
    tracker.dispose();
  });

  test("coalesces an overlapping edit at 60 seconds and keeps one beyond the boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const document = makeDocument("/workspace/burst.ts", "alpha\n");
    (vscode.workspace as { textDocuments: readonly vscode.TextDocument[] }).textDocuments = [
      document,
    ];
    const tracker = new DocumentTracker();

    replaceText(tracker, document, 0, 0, 5, "bravo");
    vi.advanceTimersByTime(60_000);
    replaceText(tracker, document, 0, 0, 5, "charlie");
    expect(tracker.getEditDiffHistory()).toHaveLength(1);
    expect(tracker.getEditDiffHistory()[0]?.diff).toContain("+charlie");
    expect(tracker.getEditDiffHistory()[0]?.diff).not.toContain("+bravo");

    vi.advanceTimersByTime(60_001);
    replaceText(tracker, document, 0, 0, 7, "delta");
    expect(tracker.getEditDiffHistory()).toHaveLength(2);
    expect(tracker.getEditDiffHistory()[0]?.diff).toContain("+delta");
    expect(tracker.getEditDiffHistory()[1]?.diff).toContain("+charlie");
    tracker.dispose();
  });

  test("merges only same-file ranges within a one-line gap and the time window", () => {
    const older = {
      filepath: "/workspace/ranges.ts",
      timestamp: 1_000,
      diff: "@@ -1 +2 @@\n-old\n+new\n@@ -4,2 +8,0 @@\n-removed",
    };
    expect(
      shouldCoalesce(
        {
          filepath: older.filepath,
          timestamp: 61_000,
          diff: "@@ -3,2 +4,1 @@\n+adjacent",
        },
        older,
      ),
    ).toBe(true);
    expect(
      shouldCoalesce(
        {
          filepath: older.filepath,
          timestamp: 61_000,
          diff: "@@ -4 +5 @@\n+two-line-gap",
        },
        { ...older, diff: "@@ -1 +2 @@\n+first" },
      ),
    ).toBe(false);
    expect(
      shouldCoalesce(
        {
          filepath: "/workspace/other.ts",
          timestamp: 1_001,
          diff: "@@ -1 +2 @@\n+other file",
        },
        older,
      ),
    ).toBe(false);
    expect(
      shouldCoalesce(
        {
          filepath: older.filepath,
          timestamp: 61_001,
          diff: "@@ -1 +2 @@\n+late",
        },
        older,
      ),
    ).toBe(false);
    expect(
      shouldCoalesce(
        {
          filepath: older.filepath,
          timestamp: 1_001,
          diff: "@@ invalid @@\n+malformed",
        },
        older,
      ),
    ).toBe(false);
  });

  test("migrates valid legacy history and persists its bounded v2 form", async () => {
    const path = "/workspace/legacy.ts";
    const records = Array.from({ length: 6 }, (_, index) => ({
      filepath: path,
      diff: `legacy edit ${index + 1}`,
      timestamp: (index + 1) * 1_000,
    }));
    const storage = makeContext(
      new Map([
        [
          "sweep.tracker.v1",
          {
            version: 1,
            editHistory: [
              records[0],
              { filepath: path, diff: "missing timestamp" },
              ...records.slice(1),
            ],
          },
        ],
      ]),
    );
    vi.spyOn(vscode.workspace.fs, "stat").mockResolvedValue({
      type: 1 as vscode.FileType,
      ctime: 0,
      mtime: 0,
      size: 0,
    });

    const tracker = new DocumentTracker(storage.context);
    await tracker.flush();

    expect(storage.values.has("sweep.tracker.v1")).toBe(false);
    expect(tracker.getEditDiffHistory().map((record) => record.timestamp)).toEqual([
      6_000, 5_000, 4_000, 3_000, 2_000, 1_000,
    ]);
    const saved = storage.values.get("sweep.tracker.v2") as {
      version: number;
      recentFileEditBuckets: Array<{ filepath: string; records: Array<{ timestamp: number }> }>;
    };
    expect(saved.version).toBe(2);
    expect(saved.recentFileEditBuckets).toEqual([
      {
        filepath: path,
        lastEditTimestamp: 6_000,
        records: [
          { filepath: path, diff: "legacy edit 2", timestamp: 2_000 },
          { filepath: path, diff: "legacy edit 3", timestamp: 3_000 },
          { filepath: path, diff: "legacy edit 4", timestamp: 4_000 },
          { filepath: path, diff: "legacy edit 5", timestamp: 5_000 },
          { filepath: path, diff: "legacy edit 6", timestamp: 6_000 },
        ],
      },
    ]);
    tracker.dispose();
  });
});
