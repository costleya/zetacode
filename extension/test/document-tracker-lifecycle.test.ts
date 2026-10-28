import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import * as vscode from "vscode";

import { DocumentTracker } from "~/telemetry/document-tracker.ts";
import { continuationDocument } from "./fixtures/continuation-document.ts";

const stateKey = "zetacode.tracker.v2";
const trackers: DocumentTracker[] = [];
const initialDocuments = vscode.workspace.textDocuments;
const statMock = vi.fn<(uri: vscode.Uri) => Promise<vscode.FileStat>>();

function documentFixture(path: string, initialText = "old();") {
  const fixture = continuationDocument(initialText);
  return {
    ...fixture,
    document: {
      ...fixture.document,
      uri: vscode.Uri.file(path),
      fileName: path,
      get version() {
        return fixture.document.version;
      },
    } as vscode.TextDocument,
  };
}

function makeTracker(seed?: unknown) {
  const values = new Map<string, unknown>();
  if (seed) values.set(stateKey, seed);
  const update = vi.fn(async (key: string, value: unknown) => {
    values.set(key, value);
  });
  const context = {
    workspaceState: {
      get: <T>(key: string) => values.get(key) as T | undefined,
      update,
    },
  } as unknown as vscode.ExtensionContext;
  const tracker = new DocumentTracker(context);
  trackers.push(tracker);
  return { tracker, values, update };
}

async function recordEdit(tracker: DocumentTracker, fixture: ReturnType<typeof documentFixture>) {
  await tracker.trackFileVisit(fixture.document);
  fixture.update("new();");
  tracker.trackChange({
    document: fixture.document,
    contentChanges: [
      {
        range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 6)),
        rangeOffset: 0,
        rangeLength: 6,
        text: "new();",
      },
    ],
  } as unknown as vscode.TextDocumentChangeEvent);
}

function persistedSeed(paths: string[]) {
  return {
    version: 2,
    savedAt: Date.now(),
    recentFileEditBuckets: paths.map((filepath) => ({
      filepath,
      lastEditTimestamp: Date.now(),
      records: [{ filepath, diff: "@@ -1 +1 @@\n-old();\n+new();", timestamp: Date.now() }],
    })),
    userActions: paths.map((file_path) => ({
      file_path,
      action_type: "INSERT_CHAR",
      line_number: 0,
      offset: 0,
      timestamp: Date.now(),
    })),
    cursorPositions: paths.map((path) => [
      vscode.Uri.file(path).toString(),
      { line: 0, timestamp: Date.now() },
    ]),
    recentFiles: paths.map((path) => ({
      uri: vscode.Uri.file(path).toString(),
      timestamp: Date.now(),
    })),
  };
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { __vscodeMockConfiguration?: Record<string, unknown> }
  ).__vscodeMockConfiguration = { maxContextFiles: 10, maxEditHistory: 20 };
  vi.spyOn(vscode.workspace, "getWorkspaceFolder").mockReturnValue({
    uri: vscode.Uri.file("/workspace"),
    name: "workspace",
    index: 0,
  });
  statMock.mockReset().mockResolvedValue({
    type: 1,
    ctime: 1,
    mtime: 1_000,
    size: 6,
  });
  vi.spyOn(vscode.workspace.fs, "stat").mockImplementation(statMock);
  vi.spyOn(vscode.workspace.fs, "readFile").mockResolvedValue(new TextEncoder().encode("new();"));
});

afterEach(() => {
  trackers.splice(0).forEach((tracker) => tracker.dispose());
  (vscode.workspace as unknown as { textDocuments: readonly vscode.TextDocument[] }).textDocuments =
    initialDocuments;
  (
    globalThis as typeof globalThis & { __vscodeMockConfiguration?: Record<string, unknown> }
  ).__vscodeMockConfiguration = {};
  vi.restoreAllMocks();
});

describe("DocumentTracker deleted-file lifecycle", () => {
  test("forgets deleted files from related snapshots and edit history and persists the cleanup", async () => {
    const { tracker, values } = makeTracker();
    const deleted = documentFixture("/workspace/continuation-trial.ts");
    const kept = documentFixture("/workspace/source.ts");
    await recordEdit(tracker, deleted);
    await recordEdit(tracker, kept);
    expect(tracker.getRecentContextFiles("", 10).map((file) => file.filepath)).toEqual(
      expect.arrayContaining(["continuation-trial.ts", "source.ts"]),
    );
    expect(tracker.getEditDiffHistory().map((edit) => edit.filepath)).toEqual(
      expect.arrayContaining([deleted.document.fileName, kept.document.fileName]),
    );

    tracker.forgetFile(deleted.document.uri);
    await tracker.flush();

    expect(tracker.getRecentContextFiles("", 10).map((file) => file.filepath)).toEqual([
      "source.ts",
    ]);
    expect(tracker.getEditDiffHistory().map((edit) => edit.filepath)).toEqual([
      kept.document.fileName,
    ]);
    expect(tracker.getOriginalContent(deleted.document.uri.toString())).toBeUndefined();
    expect(tracker.getUserActions(deleted.document.fileName)).toEqual([]);
    const persisted = values.get(stateKey) as ReturnType<typeof persistedSeed>;
    expect(persisted.recentFiles.map((entry) => entry.uri)).toEqual([kept.document.uri.toString()]);
    expect(persisted.recentFileEditBuckets.map((bucket) => bucket.filepath)).toEqual([
      kept.document.fileName,
    ]);
    expect(persisted.userActions.map((action) => action.file_path)).toEqual([
      kept.document.fileName,
    ]);
    expect(persisted.cursorPositions.map(([uri]) => uri)).toEqual([kept.document.uri.toString()]);
  });

  test("folder deletion removes descendants while keeping similarly named siblings", async () => {
    const { tracker } = makeTracker();
    const child = documentFixture("/workspace/tmp/a.ts");
    const nested = documentFixture("/workspace/tmp/nested/b.ts");
    const sibling = documentFixture("/workspace/tmp-kept/c.ts");
    for (const fixture of [child, nested, sibling]) await recordEdit(tracker, fixture);

    tracker.forgetFile(vscode.Uri.file("/workspace/tmp"));

    expect(tracker.getRecentContextFiles("", 10).map((file) => file.filepath)).toEqual([
      "tmp-kept/c.ts",
    ]);
    expect(tracker.getEditDiffHistory().map((edit) => edit.filepath)).toEqual([
      sibling.document.fileName,
    ]);
  });

  test("a delayed file visit cannot restore a deleted snapshot", async () => {
    const { tracker } = makeTracker();
    const kept = documentFixture("/workspace/source.ts");
    await recordEdit(tracker, kept);
    let resolveStat!: (value: vscode.FileStat) => void;
    statMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStat = resolve;
        }),
    );
    const deleted = documentFixture("/workspace/continuation-trial.ts");
    const visit = tracker.trackFileVisit(deleted.document);

    tracker.forgetFile(deleted.document.uri);
    resolveStat({ type: 1, ctime: 1, mtime: 1_000, size: 6 });
    await visit;

    expect(tracker.getRecentContextFiles("", 10).map((file) => file.filepath)).toEqual([
      "source.ts",
    ]);
    expect(tracker.getOriginalContent(deleted.document.uri.toString())).toBeUndefined();
  });

  test("startup excludes missing persisted history and snapshots while preserving valid files", async () => {
    const missing = "/workspace/continuation-trial.ts";
    const kept = "/workspace/source.ts";
    statMock.mockImplementation(async (uri) => {
      if (uri.fsPath === missing) throw vscode.FileSystemError.FileNotFound(missing);
      return { type: 1, ctime: 1, mtime: 1_000, size: 6 };
    });
    const { tracker, values } = makeTracker(persistedSeed([missing, kept]));

    await tracker.flush();

    expect(tracker.getEditDiffHistory().map((edit) => edit.filepath)).toEqual([kept]);
    expect(tracker.getRecentContextFiles("", 10).map((file) => file.filepath)).toEqual([
      "source.ts",
    ]);
    expect(tracker.getUserActions(missing)).toEqual([]);
    const persisted = values.get(stateKey) as ReturnType<typeof persistedSeed>;
    expect(persisted.recentFileEditBuckets.map((bucket) => bucket.filepath)).toEqual([kept]);
    expect(persisted.recentFiles.map((entry) => entry.uri)).toEqual([
      vscode.Uri.file(kept).toString(),
    ]);
  });

  test("startup preserves an open dirty document even when its file is absent on disk", async () => {
    const fixture = documentFixture("/workspace/unsaved.ts");
    const document = { ...fixture.document, isDirty: true } as vscode.TextDocument;
    (
      vscode.workspace as unknown as { textDocuments: readonly vscode.TextDocument[] }
    ).textDocuments = [document];
    statMock.mockRejectedValue(vscode.FileSystemError.FileNotFound(document.fileName));
    const { tracker } = makeTracker(persistedSeed([document.fileName]));

    await tracker.flush();

    expect(tracker.getEditDiffHistory().map((edit) => edit.filepath)).toEqual([document.fileName]);
  });

  test("deletion during startup validation cannot restore persisted context", async () => {
    const path = "/workspace/continuation-trial.ts";
    let resolveStat!: (value: vscode.FileStat) => void;
    statMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStat = resolve;
        }),
    );
    const { tracker, values } = makeTracker(persistedSeed([path]));
    expect(tracker.getEditDiffHistory()).toEqual([]);

    tracker.forgetFile(vscode.Uri.file(path));
    resolveStat({ type: 1, ctime: 1, mtime: 1_000, size: 6 });
    await tracker.flush();

    expect(tracker.getRecentContextFiles("", 10)).toEqual([]);
    expect(tracker.getEditDiffHistory()).toEqual([]);
    const persisted = values.get(stateKey) as ReturnType<typeof persistedSeed>;
    expect(persisted.recentFileEditBuckets).toEqual([]);
    expect(persisted.recentFiles).toEqual([]);
  });

  test("restores closed remote history using its persisted URI rather than a local file URI", async () => {
    const path = "/workspace/source.ts";
    const remoteUri = "vscode-remote://ssh-remote+dev/workspace/source.ts";
    vi.spyOn(vscode.Uri, "parse").mockImplementation(
      (value) =>
        ({
          scheme: value === remoteUri ? "vscode-remote" : "file",
          authority: value === remoteUri ? "ssh-remote+dev" : "",
          fsPath: value === remoteUri ? path : value,
          path: value === remoteUri ? path : value,
          toString: () => value,
        }) as vscode.Uri,
    );
    statMock.mockImplementation(async (uri) => {
      if (uri.scheme !== "vscode-remote") throw vscode.FileSystemError.FileNotFound(uri.fsPath);
      return { type: 1, ctime: 1, mtime: 1_000, size: 6 };
    });
    const seed = persistedSeed([path]);
    seed.recentFiles[0]!.uri = remoteUri;
    seed.cursorPositions = [[remoteUri, { line: 0, timestamp: Date.now() }]];
    const { tracker } = makeTracker(seed);

    await tracker.flush();

    expect(statMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scheme: "vscode-remote",
        authority: "ssh-remote+dev",
        fsPath: path,
      }),
    );
    expect(tracker.getEditDiffHistory().map((edit) => edit.filepath)).toEqual([path]);
    expect(tracker.getRecentContextFiles("", 10)).toEqual([
      expect.objectContaining({ filepath: "source.ts", content: "new();" }),
    ]);
  });

  test.each(["NoPermissions", "Unavailable"])(
    "retains valid persisted history across a temporary %s filesystem error",
    async (code) => {
      const path = "/workspace/source.ts";
      const error =
        code === "NoPermissions"
          ? vscode.FileSystemError.NoPermissions(path)
          : vscode.FileSystemError.Unavailable(path);
      statMock.mockRejectedValue(error);
      const { tracker, values } = makeTracker(persistedSeed([path]));

      await tracker.flush();

      expect(tracker.getEditDiffHistory().map((edit) => edit.filepath)).toEqual([path]);
      expect(tracker.getUserActions(path)).toHaveLength(1);
      tracker.trackCursorMovement(documentFixture(path).document, new vscode.Position(0, 0));
      await tracker.flush();
      const persisted = values.get(stateKey) as ReturnType<typeof persistedSeed>;
      expect(persisted.recentFileEditBuckets.map((bucket) => bucket.filepath)).toEqual([path]);
      expect(persisted.recentFiles.map((entry) => entry.uri)).toEqual([
        vscode.Uri.file(path).toString(),
      ]);
    },
  );

  test("an older startup snapshot read failure cannot erase newer live context and edits", async () => {
    const path = "/workspace/source.ts";
    let rejectRead!: (reason: unknown) => void;
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    vi.spyOn(vscode.workspace.fs, "readFile").mockImplementationOnce(() => {
      markReadStarted();
      return new Promise<Uint8Array>((_resolve, reject) => {
        rejectRead = reject;
      });
    });
    const { tracker } = makeTracker(persistedSeed([path]));
    await readStarted;
    const fixture = documentFixture(path);
    await recordEdit(tracker, fixture);
    await tracker.trackFileVisit(fixture.document);
    const freshHistory = tracker.getEditDiffHistory();
    expect(freshHistory.length).toBeGreaterThan(0);

    rejectRead(vscode.FileSystemError.FileNotFound(path));
    await tracker.flush();

    expect(tracker.getRecentContextFiles("", 10)).toEqual([
      expect.objectContaining({ filepath: "source.ts", content: "new();" }),
    ]);
    expect(tracker.getEditDiffHistory()).toEqual(freshHistory);
    expect(tracker.getOriginalContent(fixture.document.uri.toString())).toBe("old();");
  });

  test("an older startup history check cannot erase a newer successful visit", async () => {
    const path = "/workspace/source.ts";
    let rejectStat!: (reason: unknown) => void;
    statMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectStat = reject;
        }),
    );
    const { tracker } = makeTracker(persistedSeed([path]));
    const fixture = documentFixture(path, "fresh();");
    await tracker.trackFileVisit(fixture.document);

    rejectStat(vscode.FileSystemError.FileNotFound(path));
    await tracker.flush();

    expect(tracker.getRecentContextFiles("", 10)).toEqual([
      expect.objectContaining({ filepath: "source.ts", content: "fresh();" }),
    ]);
    expect(tracker.getOriginalContent(fixture.document.uri.toString())).toBe("fresh();");
    expect(tracker.getEditDiffHistory().map((edit) => edit.filepath)).toEqual([path]);
  });

  test("an older startup history check preserves a document opened dirty while stat was pending", async () => {
    const path = "/workspace/source.ts";
    let rejectStat!: (reason: unknown) => void;
    statMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectStat = reject;
        }),
    );
    const { tracker } = makeTracker(persistedSeed([path]));
    const fixture = documentFixture(path, "unsaved();");
    const document = { ...fixture.document, isDirty: true } as vscode.TextDocument;
    (
      vscode.workspace as unknown as { textDocuments: readonly vscode.TextDocument[] }
    ).textDocuments = [document];

    rejectStat(vscode.FileSystemError.FileNotFound(path));
    await tracker.flush();

    expect(tracker.getEditDiffHistory().map((edit) => edit.filepath)).toEqual([path]);
    expect(tracker.getRecentContextFiles("", 10)).toEqual([
      expect.objectContaining({ filepath: "source.ts", content: "unsaved();" }),
    ]);
  });
});
