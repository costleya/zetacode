import * as vscode from "vscode";

import type { ActionType, UserAction } from "~/api/schemas.ts";
import { shouldCoalesce } from "~/telemetry/edit-merger.ts";
import { formatRecentChangeDiff } from "~/telemetry/unified-diff.ts";
import { normalizePathSeparators } from "~/utils/path.ts";
import { utf8ByteOffsetAt } from "~/utils/text.ts";

type FileSnapshot = {
  uri: string;
  content: string;
  timestamp: number;
  mtime?: number;
};

type CursorSnapshot = {
  line: number;
  timestamp: number;
};

type ChangeSummary = {
  timestamp: number;
  totalChars: number;
  totalLines: number;
};

export type EditRecord = {
  filepath: string;
  diff: string;
  timestamp: number;
};

export type ContextFile = {
  filepath: string;
  content: string;
  mtime?: number;
  cursorLine?: number;
};

export function isTrackableDocument(document: vscode.TextDocument): boolean {
  return ["file", "untitled", "vscode-remote"].includes(document.uri.scheme);
}
export function isInWorkspace(uri: vscode.Uri): boolean {
  return !!vscode.workspace.getWorkspaceFolder(uri);
}

export class DocumentTracker implements vscode.Disposable {
  private recentFiles = new Map<string, FileSnapshot>();
  private editHistory = new Map<string, EditRecord[]>();
  private activeUri: string | undefined;
  private activePath: string | undefined;
  private context: vscode.ExtensionContext | undefined;
  private loading: Promise<void>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  private writing: Promise<void> = Promise.resolve();
  private revision = 0;
  private pathRevisions = new Map<string, number>();
  private editRevisions = new Map<string, number>();
  private deletions = new Map<string, number>();
  private unavailable = new Map<string, FileSnapshot>();
  private newline:
    | { uri: string; version: number; line: number; character: number; timestamp: number }
    | undefined;
  private userActions: UserAction[] = [];
  private originalContents = new Map<string, string>();
  private documentContents = new Map<string, string>();
  private cursorPositions = new Map<string, CursorSnapshot>();
  private lastChangeSummaries = new Map<string, ChangeSummary>();
  private lastMultiLineSelections = new Map<string, number>();
  private maxRecentFiles = 10;
  private maxUserActions = 50;

  constructor(context?: vscode.ExtensionContext) {
    this.context = context;
    for (const doc of vscode.workspace.textDocuments) {
      if (!isTrackableDocument(doc)) continue;
      this.originalContents.set(doc.uri.toString(), doc.getText());
      this.documentContents.set(doc.uri.toString(), doc.getText());
    }
    this.loading = context ? this.load() : Promise.resolve();
  }

  async trackFileVisit(document: vscode.TextDocument): Promise<void> {
    if (!isTrackableDocument(document)) return;
    const uri = document.uri.toString();
    const path = normalizePathSeparators(document.fileName);
    const revision = this.touch(path);

    if (!this.originalContents.has(uri)) {
      this.originalContents.set(uri, document.getText());
    }
    this.documentContents.set(uri, document.getText());

    if (!isInWorkspace(document.uri)) return;
    let mtime: number | undefined;
    try {
      const stat = await vscode.workspace.fs.stat(document.uri);
      mtime = Math.floor(stat.mtime / 1000);
    } catch {
      if (!document.isDirty && document.uri.scheme !== "untitled") return;
    }
    if (this.pathRevisions.get(path) !== revision) return;

    const snapshot: FileSnapshot = {
      uri,
      content: document.getText(),
      timestamp: Date.now(),
      ...(mtime !== undefined ? { mtime } : {}),
    };
    this.recentFiles.set(uri, snapshot);

    this.pruneRecentFiles();
    this.unavailable.delete(uri);
    this.markDirty();
  }

  trackChange(event: vscode.TextDocumentChangeEvent): void {
    if (!isTrackableDocument(event.document)) return;
    const filepath = normalizePathSeparators(event.document.fileName);
    const uri = event.document.uri.toString();
    const now = Date.now();
    if (event.contentChanges.length) {
      this.editRevisions.set(filepath, this.touch(filepath));
      this.newline = undefined;
      const c = event.contentChanges[0];
      if (
        this.activeUri === uri &&
        !event.reason &&
        event.contentChanges.length === 1 &&
        c &&
        c.rangeLength === 0 &&
        c.range.start.line === c.range.end.line &&
        c.range.start.character === c.range.end.character &&
        /^(?:\r\n|\n|\r)[ \t]{0,200}$/.test(c.text)
      ) {
        const pos = this.getPostChangePosition(event.document, c);
        if (/^[ \t]*$/.test(event.document.lineAt(pos.line).text))
          this.newline = {
            uri,
            version: event.document.version,
            line: pos.line,
            character: pos.character,
            timestamp: now,
          };
      }
    }
    const previousDocumentContent = this.documentContents.get(uri);
    let totalChars = 0;
    let totalLines = 0;
    const undoRedoActionType = this.getUndoRedoActionType(event.reason);
    let undoRedoPosition: vscode.Position | null = null;

    for (const change of event.contentChanges) {
      if (!change.text && change.rangeLength === 0) continue;
      const actionPosition = this.getPostChangePosition(event.document, change);

      this.cursorPositions.set(uri, {
        line: actionPosition.line,
        timestamp: now,
      });

      const diff = previousDocumentContent
        ? formatRecentChangeDiff({
            filepath,
            previousContent: previousDocumentContent,
            range: change.range,
            rangeOffset: change.rangeOffset,
            rangeLength: change.rangeLength,
            newText: change.text,
          })
        : this.formatDiff(filepath, change.range, change.text, change.rangeLength);
      if (diff) {
        this.addEdit({ filepath, diff, timestamp: now });
      }

      if (undoRedoActionType) {
        undoRedoPosition = actionPosition;
      } else {
        const actionType = this.getActionType(change);
        const offset = utf8ByteOffsetAt(event.document, actionPosition);

        this.userActions.push({
          action_type: actionType,
          line_number: actionPosition.line,
          offset,
          file_path: filepath,
          timestamp: now,
        });
        this.pruneUserActions();
      }

      totalChars += change.text.length + change.rangeLength;
      const insertedLines = Math.max(0, change.text.split("\n").length - 1);
      const removedLines = change.range.end.line - change.range.start.line;
      totalLines += insertedLines + removedLines;
    }

    if (totalChars > 0 || totalLines > 0) {
      this.lastChangeSummaries.set(uri, {
        timestamp: now,
        totalChars,
        totalLines,
      });
    }

    if (undoRedoActionType && undoRedoPosition) {
      this.userActions.push({
        action_type: undoRedoActionType,
        line_number: undoRedoPosition.line,
        offset: utf8ByteOffsetAt(event.document, undoRedoPosition),
        file_path: filepath,
        timestamp: now,
      });
      this.pruneUserActions();
    }

    this.documentContents.set(uri, event.document.getText());
    const snapshot = this.recentFiles.get(uri);
    if (snapshot) snapshot.content = event.document.getText();
    if (event.contentChanges.length) this.markDirty();
  }

  trackCursorMovement(document: vscode.TextDocument, position: vscode.Position): void {
    if (!isTrackableDocument(document)) return;
    if (
      this.newline &&
      (this.newline.uri !== document.uri.toString() ||
        this.newline.line !== position.line ||
        this.newline.character !== position.character)
    )
      this.newline = undefined;
    const filepath = normalizePathSeparators(document.fileName);
    const offset = utf8ByteOffsetAt(document, position);
    const uri = document.uri.toString();
    const timestamp = Date.now();

    this.cursorPositions.set(uri, {
      line: position.line,
      timestamp,
    });

    this.userActions.push({
      action_type: "CURSOR_MOVEMENT",
      line_number: position.line,
      offset,
      file_path: filepath,
      timestamp,
    });
    this.pruneUserActions();
    this.touch(filepath);
    this.markDirty();
  }

  trackSelectionChange(
    document: vscode.TextDocument,
    selections: readonly vscode.Selection[],
  ): void {
    if (!isTrackableDocument(document)) return;
    if (
      this.newline &&
      (selections.length !== 1 ||
        !selections[0] ||
        !selections[0].isEmpty ||
        selections[0].active.line !== this.newline.line ||
        selections[0].active.character !== this.newline.character ||
        document.uri.toString() !== this.newline.uri)
    )
      this.newline = undefined;
    let hasMultiLine = false;
    for (const selection of selections) {
      if (selection.isEmpty) continue;
      if (selection.start.line !== selection.end.line) {
        hasMultiLine = true;
        break;
      }
    }

    if (hasMultiLine) {
      this.lastMultiLineSelections.set(document.uri.toString(), Date.now());
    }
  }

  private getActionType(change: vscode.TextDocumentContentChangeEvent): ActionType {
    const isMultiChar = change.text.length > 1 || change.rangeLength > 1;

    if (change.rangeLength > 0 && change.text.length > 0) {
      return isMultiChar ? "INSERT_SELECTION" : "INSERT_CHAR";
    }
    if (change.rangeLength > 0) {
      return isMultiChar ? "DELETE_SELECTION" : "DELETE_CHAR";
    }
    return isMultiChar ? "INSERT_SELECTION" : "INSERT_CHAR";
  }

  private getPostChangePosition(
    document: vscode.TextDocument,
    change: vscode.TextDocumentContentChangeEvent,
  ): vscode.Position {
    const insertionEndOffset = change.rangeOffset + change.text.length;
    const documentLength = document.getText().length;
    const clampedOffset = Math.max(0, Math.min(insertionEndOffset, documentLength));
    return document.positionAt(clampedOffset);
  }

  private getUndoRedoActionType(
    reason: vscode.TextDocumentChangeReason | undefined,
  ): Extract<ActionType, "UNDO" | "REDO"> | null {
    if (reason === vscode.TextDocumentChangeReason.Undo) {
      return "UNDO";
    }
    if (reason === vscode.TextDocumentChangeReason.Redo) {
      return "REDO";
    }
    return null;
  }

  getRecentContextFiles(excludeUri: string, maxFiles: number): ContextFile[] {
    return Array.from(this.recentFiles.entries())
      .filter(([uri]) => uri !== excludeUri)
      .sort((a, b) => b[1].timestamp - a[1].timestamp)
      .slice(0, maxFiles)
      .map(([, snapshot]) => {
        const cursor = this.cursorPositions.get(snapshot.uri);
        return {
          filepath: this.getRelativePath(snapshot.uri),
          content: snapshot.content,
          ...(snapshot.mtime !== undefined ? { mtime: snapshot.mtime } : {}),
          ...(cursor ? { cursorLine: cursor.line } : {}),
        };
      });
  }

  getEditDiffHistory(): EditRecord[] {
    const config = vscode.workspace.getConfiguration("sweep");
    const limit = Math.max(1, config.get<number>("maxEditHistory", 15));
    const otherLimit = Math.max(0, config.get<number>("maxContextFiles", 5));
    const active = this.activePath
      ? [...(this.editHistory.get(this.activePath) ?? [])].sort((a, b) => b.timestamp - a.timestamp)
      : [];
    const others = [...this.editHistory.entries()]
      .filter(([path]) => path !== this.activePath)
      .map(([, records]) => [...records].sort((a, b) => b.timestamp - a.timestamp))
      .filter((x) => x.length)
      .sort((a, b) => (b[0]?.timestamp ?? 0) - (a[0]?.timestamp ?? 0))
      .slice(0, otherLimit);
    const floor = Math.min(active.length, Math.max(1, Math.ceil(limit * 0.2)));
    const otherBudget = Math.min(limit - floor, Math.round(limit * 0.4));
    const chosen = active.slice(0, floor);
    const pool = others.flat().sort((a, b) => b.timestamp - a.timestamp);
    chosen.push(...pool.splice(0, otherBudget));
    const rest = [...active.slice(floor), ...pool].sort((a, b) => b.timestamp - a.timestamp);
    chosen.push(...rest.slice(0, limit - chosen.length));
    return chosen.sort((a, b) => b.timestamp - a.timestamp);
  }

  getUserActions(filePath: string, currentCursor?: { line: number; offset: number }): UserAction[] {
    const normalizedPath = normalizePathSeparators(filePath);
    const actions = this.userActions.filter((a) => a.file_path === normalizedPath);

    if (!currentCursor) {
      return actions;
    }

    const lastAction = actions.at(-1);
    const cursorChanged =
      !lastAction ||
      lastAction.action_type !== "CURSOR_MOVEMENT" ||
      lastAction.line_number !== currentCursor.line ||
      lastAction.offset !== currentCursor.offset;
    if (!cursorChanged) {
      return actions;
    }

    return [
      ...actions,
      {
        action_type: "CURSOR_MOVEMENT",
        line_number: currentCursor.line,
        offset: currentCursor.offset,
        file_path: normalizedPath,
        timestamp: Date.now(),
      },
    ];
  }

  getOriginalContent(uri: string): string | undefined {
    return this.originalContents.get(uri);
  }

  wasRecentBulkChange(
    uri: string,
    options: {
      windowMs: number;
      charThreshold: number;
      lineThreshold: number;
    },
  ): boolean {
    const summary = this.lastChangeSummaries.get(uri);
    if (!summary) return false;
    if (Date.now() - summary.timestamp > options.windowMs) return false;
    return (
      summary.totalChars >= options.charThreshold || summary.totalLines >= options.lineThreshold
    );
  }

  wasRecentMultiLineSelection(uri: string, windowMs: number): boolean {
    const timestamp = this.lastMultiLineSelections.get(uri);
    if (!timestamp) return false;
    return Date.now() - timestamp <= windowMs;
  }

  resetOriginalContent(uri: string, content: string): void {
    this.originalContents.set(uri, content);
  }

  private formatDiff(
    filepath: string,
    range: vscode.Range,
    newText: string,
    deletedLength: number,
  ): string | null {
    const deletedLines = deletedLength > 0 ? 1 : 0;
    const addedLines = newText ? newText.split("\n").length : 0;

    const lines = [
      `Index: ${filepath}`,
      "===================================================================",
      `@@ -${range.start.line + 1},${deletedLines} +${range.start.line + 1},${addedLines} @@`,
    ];

    if (deletedLength > 0) {
      lines.push(`-[deleted ${deletedLength} characters]`);
    }
    if (newText) {
      for (const line of newText.split("\n")) {
        lines.push(`+${line}`);
      }
    }

    return lines.join("\n");
  }

  private getRelativePath(uri: string): string {
    try {
      const parsedUri = vscode.Uri.parse(uri);
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(parsedUri);
      if (workspaceFolder) {
        const relativePath = parsedUri.fsPath.slice(workspaceFolder.uri.fsPath.length + 1);
        return normalizePathSeparators(relativePath);
      }
      return normalizePathSeparators(parsedUri.fsPath);
    } catch {
      return uri;
    }
  }

  private pruneRecentFiles(): void {
    if (this.recentFiles.size <= this.maxRecentFiles) return;

    const sorted = Array.from(this.recentFiles.entries()).sort(
      (a, b) => b[1].timestamp - a[1].timestamp,
    );
    this.recentFiles = new Map(sorted.slice(0, this.maxRecentFiles));
  }

  private addEdit(record: EditRecord): void {
    let bucket = this.editHistory.get(record.filepath) ?? [];
    bucket = bucket.filter((old) => !shouldCoalesce(old, record));
    bucket.push(record);
    bucket.sort((a, b) => a.timestamp - b.timestamp);
    this.editHistory.set(record.filepath, bucket.slice(-15));
    if (this.editHistory.size > 10) {
      const oldest = [...this.editHistory.entries()].sort(
        (a, b) => (a[1].at(-1)?.timestamp ?? 0) - (b[1].at(-1)?.timestamp ?? 0),
      )[0];
      if (oldest) this.editHistory.delete(oldest[0]);
    }
  }

  private pruneUserActions(): void {
    if (this.userActions.length > this.maxUserActions) {
      this.userActions = this.userActions.slice(-this.maxUserActions);
    }
  }

  private touch(path: string): number {
    const revision = ++this.revision;
    this.pathRevisions.set(path, revision);
    return revision;
  }
  private markDirty(): void {
    if (!this.context) return;
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush();
    }, 300_000);
  }
  setActiveFile(document: vscode.TextDocument | undefined | null): void {
    if (document && !isTrackableDocument(document)) return;
    const uri = document?.uri.toString();
    if (uri !== this.activeUri) this.newline = undefined;
    this.activeUri = uri;
    this.activePath = document ? normalizePathSeparators(document.fileName) : undefined;
  }
  hasRecentNewlineInsertion(document: vscode.TextDocument, position: vscode.Position): boolean {
    const n = this.newline;
    return (
      !!n &&
      n.uri === document.uri.toString() &&
      n.version === document.version &&
      n.line === position.line &&
      n.character === position.character &&
      Date.now() - n.timestamp <= 10_000 &&
      /^[ \t]*$/.test(document.lineAt(position.line).text)
    );
  }
  forgetFile(uri: vscode.Uri): void {
    const target = normalizePathSeparators(uri.fsPath).replace(/\/$/, "");
    const matches = (path: string) => path === target || path.startsWith(target + "/");
    const uriMatches = (key: string) => {
      try {
        const parsed = vscode.Uri.parse(key);
        return (
          parsed.scheme === uri.scheme &&
          parsed.authority === uri.authority &&
          matches(normalizePathSeparators(parsed.fsPath))
        );
      } catch {
        return false;
      }
    };
    // Invalidating all pending loads also covers paths not yet materialized in maps.
    this.deletions.set(target, ++this.revision);
    for (const [path] of this.pathRevisions)
      if (matches(path)) this.pathRevisions.set(path, this.revision);
    for (const map of [
      this.recentFiles,
      this.unavailable,
      this.originalContents,
      this.documentContents,
      this.cursorPositions,
      this.lastChangeSummaries,
      this.lastMultiLineSelections,
    ]) {
      for (const key of map.keys()) if (uriMatches(key)) map.delete(key);
    }
    for (const path of this.editHistory.keys()) if (matches(path)) this.editHistory.delete(path);
    this.userActions = this.userActions.filter((a) => !matches(a.file_path));
    if (this.newline && uriMatches(this.newline.uri)) this.newline = undefined;
    this.markDirty();
  }
  async flush(): Promise<void> {
    if (!this.context) return;
    await this.loading;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.dirty) {
      await this.writing;
      return;
    }
    this.dirty = false;
    const recentFiles = [...this.recentFiles.values(), ...this.unavailable.values()].map(
      ({ uri, timestamp, mtime }) => ({
        uri,
        timestamp,
        mtime,
        cursorLine: this.cursorPositions.get(uri)?.line,
      }),
    );
    const editHistory = [...this.editHistory.entries()].map(([filepath, records]) => ({
      filepath,
      lastEditTimestamp: records.at(-1)?.timestamp ?? 0,
      records: records.slice(-5),
    }));
    const payload = {
      version: 2,
      savedAt: Date.now(),
      recentFileEditBuckets: editHistory,
      userActions: [...this.userActions],
      cursorPositions: [...this.cursorPositions.entries()],
      recentFiles,
    };
    this.writing = this.writing.then(async () => {
      try {
        await this.context!.workspaceState.update("sweep.tracker.v2", payload);
      } catch {
        this.dirty = true;
      }
    });
    await this.writing;
  }
  private async load(): Promise<void> {
    if (!this.context) return;
    const state = this.context.workspaceState;
    let data: any;
    try {
      data = state.get("sweep.tracker.v2");
    } catch {
      return;
    }
    let legacy = false;
    if (!data || data.version !== 2) {
      try {
        data = state.get("sweep.tracker.v1");
      } catch {
        return;
      }
      if (!data || data.version !== 1) return;
      legacy = true;
    }
    const startRevision = this.revision;
    const validRecord = (r: any): r is EditRecord =>
      !!r &&
      typeof r.filepath === "string" &&
      typeof r.diff === "string" &&
      typeof r.timestamp === "number";
    const records: EditRecord[] = legacy
      ? Array.isArray(data.editHistory)
        ? data.editHistory.filter(validRecord)
        : []
      : Array.isArray(data.recentFileEditBuckets)
        ? data.recentFileEditBuckets.flatMap((b: any) =>
            typeof b?.filepath === "string" && Array.isArray(b.records)
              ? b.records.filter(validRecord)
              : [],
          )
        : [];
    const metadata: any[] = Array.isArray(data.recentFiles) ? data.recentFiles : [];
    const changed = (path: string) =>
      (this.pathRevisions.get(path) ?? 0) > startRevision ||
      [...this.deletions].some(
        ([deleted, revision]) =>
          revision > startRevision && (path === deleted || path.startsWith(deleted + "/")),
      );
    const historyChanged = (path: string) =>
      (this.editRevisions.get(path) ?? 0) > startRevision ||
      [...this.deletions].some(
        ([deleted, revision]) =>
          revision > startRevision && (path === deleted || path.startsWith(deleted + "/")),
      );
    const validPaths = new Set<string>();
    const missingPaths = new Set<string>();
    for (const item of metadata) {
      if (typeof item?.uri !== "string") continue;
      let uri: vscode.Uri;
      try {
        uri = vscode.Uri.parse(item.uri);
        if (!uri.scheme || !isInWorkspace(uri)) continue;
      } catch {
        continue;
      }
      const path = normalizePathSeparators(uri.fsPath);
      if (changed(path)) continue;
      const openDirty = () =>
        vscode.workspace.textDocuments.find(
          (d) => d.uri.toString() === item.uri && (d.isDirty || d.uri.scheme === "untitled"),
        );
      try {
        let open = openDirty();
        if (!open) await vscode.workspace.fs.stat(uri);
        open = openDirty();
        const content = open
          ? open.getText()
          : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
        if (changed(path)) continue;
        validPaths.add(path);
        this.recentFiles.set(item.uri, {
          uri: item.uri,
          content,
          timestamp: typeof item.timestamp === "number" ? item.timestamp : 0,
          ...(typeof item.mtime === "number" ? { mtime: item.mtime } : {}),
        });
        if (typeof item.cursorLine === "number")
          this.cursorPositions.set(item.uri, {
            line: item.cursorLine,
            timestamp: item.timestamp ?? 0,
          });
      } catch (error) {
        if (changed(path)) continue;
        const open = openDirty();
        if (open) {
          validPaths.add(path);
          this.recentFiles.set(item.uri, {
            uri: item.uri,
            content: open.getText(),
            timestamp: item.timestamp ?? 0,
            ...(typeof item.mtime === "number" ? { mtime: item.mtime } : {}),
          });
          if (typeof item.cursorLine === "number")
            this.cursorPositions.set(item.uri, {
              line: item.cursorLine,
              timestamp: item.timestamp ?? 0,
            });
          continue;
        }
        const code = (error as { code?: string }).code;
        if (code === "FileNotFound" || code === "ENOENT") missingPaths.add(path);
        else {
          this.unavailable.set(item.uri, {
            uri: item.uri,
            content: "",
            timestamp: item.timestamp ?? 0,
            ...(typeof item.mtime === "number" ? { mtime: item.mtime } : {}),
          });
          if (typeof item.cursorLine === "number")
            this.cursorPositions.set(item.uri, {
              line: item.cursorLine,
              timestamp: item.timestamp ?? 0,
            });
        }
      }
    }
    // Paths without metadata can be checked locally only when no remote workspace
    // makes the filesystem identity ambiguous.
    const remoteWorkspace = vscode.workspace.workspaceFolders?.some(
      (f) => f.uri.scheme === "vscode-remote",
    );
    if (!remoteWorkspace)
      for (const path of new Set(records.map((r) => r.filepath))) {
        if (validPaths.has(path) || missingPaths.has(path) || changed(path)) continue;
        const open = vscode.workspace.textDocuments.find(
          (d) =>
            normalizePathSeparators(d.fileName) === path &&
            (d.isDirty || d.uri.scheme === "untitled"),
        );
        if (open) continue;
        try {
          await vscode.workspace.fs.stat(vscode.Uri.file(path));
        } catch (error) {
          if (["FileNotFound", "ENOENT"].includes((error as { code?: string }).code ?? ""))
            missingPaths.add(path);
        }
      }
    for (const record of records.sort((a, b) => a.timestamp - b.timestamp)) {
      if (missingPaths.has(record.filepath) || historyChanged(record.filepath)) continue;
      this.addEdit(record);
    }
    if (Array.isArray(data.userActions))
      this.userActions = [
        ...data.userActions.filter(
          (a: UserAction) => !missingPaths.has(a.file_path) && !changed(a.file_path),
        ),
        ...this.userActions,
      ].slice(-50);
    if (Array.isArray(data.cursorPositions))
      for (const tuple of data.cursorPositions)
        if (
          Array.isArray(tuple) &&
          typeof tuple[0] === "string" &&
          !this.cursorPositions.has(tuple[0])
        ) {
          try {
            const path = normalizePathSeparators(vscode.Uri.parse(tuple[0]).fsPath);
            if (!missingPaths.has(path) && !changed(path))
              this.cursorPositions.set(tuple[0], tuple[1]);
          } catch {
            /* malformed URI */
          }
        }
    this.pruneRecentFiles();
    if (missingPaths.size) this.markDirty();
    if (legacy) {
      this.markDirty();
      try {
        await state.update("sweep.tracker.v1", undefined);
      } catch {
        /* best effort */
      }
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.recentFiles.clear();
    this.editHistory.clear();
    this.userActions = [];
    this.originalContents.clear();
    this.documentContents.clear();
    this.cursorPositions.clear();
    this.lastChangeSummaries.clear();
    this.lastMultiLineSelections.clear();
  }
}
