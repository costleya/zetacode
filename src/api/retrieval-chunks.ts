import * as vscode from "vscode";
import { toUnixPath } from "~/utils/path.ts";
import { isFileTooLarge } from "~/utils/text.ts";
import type { FileChunk, RecentBuffer } from "./schemas.ts";

const MAX_DEFINITION_CHUNKS = 6;
const MAX_REFERENCE_CHUNKS = 6;
const MAX_RETRIEVAL_CHUNKS = 16;
const MAX_RETRIEVAL_LINES = 200;
const CONTEXT_LINES = 9;
const MAX_RECENT_BUFFER_LINES = 30;
const MAX_CLIPBOARD_LINES = 20;

export type RetrievalFileLoader = (uri: vscode.Uri) => Thenable<Uint8Array>;
export type OpenDocumentsProvider = () => readonly vscode.TextDocument[];

export interface RetrievalChunkOptions {
  document: vscode.TextDocument;
  position: vscode.Position;
  currentFilePath?: string;
  activeContextRange?: { startLine: number; endLine: number };
  recentBuffers?: readonly RecentBuffer[];
  diagnostics?: readonly vscode.Diagnostic[];
  includeClipboard?: boolean;
  maxChunks?: number;
  maxChunkLines?: number;
  retrievalFileLoader?: RetrievalFileLoader;
  openDocumentsProvider?: OpenDocumentsProvider;
}

/** Convert recent editor buffers into the shared API chunk shape. */
export function buildRecentBufferChunks(buffers: readonly RecentBuffer[]): FileChunk[] {
  return buffers
    .filter((buffer) => !isFileTooLarge(buffer.content))
    .slice(0, 3)
    .map((buffer) => {
      if (buffer.startLine !== undefined && buffer.endLine !== undefined) {
        return {
          file_path: toUnixPath(buffer.path),
          start_line: buffer.startLine,
          end_line: buffer.endLine,
          content: buffer.content,
          ...(buffer.mtime !== undefined ? { timestamp: buffer.mtime } : {}),
        };
      }

      const lines = buffer.content.split("\n");
      const lineCount = Math.min(MAX_RECENT_BUFFER_LINES, lines.length);
      return {
        file_path: toUnixPath(buffer.path),
        start_line: 0,
        end_line: lineCount,
        content: lines.slice(0, lineCount).join("\n"),
        ...(buffer.mtime !== undefined ? { timestamp: buffer.mtime } : {}),
      };
    });
}

/** Gather optional definition, reference, clipboard, diagnostic, and recent-buffer context. */
export async function buildRetrievalChunks(options: RetrievalChunkOptions): Promise<FileChunk[]> {
  const {
    document,
    position,
    activeContextRange,
    maxChunks = MAX_RETRIEVAL_CHUNKS,
    maxChunkLines = MAX_RETRIEVAL_LINES,
  } = options;
  const retrievalFileLoader =
    options.retrievalFileLoader ?? ((uri: vscode.Uri) => vscode.workspace.fs.readFile(uri));
  const openDocumentsProvider =
    options.openDocumentsProvider ?? (() => vscode.workspace.textDocuments);
  const currentPath = toUnixPath(
    options.currentFilePath ?? document.uri.fsPath ?? document.uri.toString(),
  );
  const [definitions, references, clipboard] = await Promise.all([
    getDefinitionChunks(document, position, retrievalFileLoader, openDocumentsProvider),
    getReferenceChunks(document, position, retrievalFileLoader, openDocumentsProvider),
    options.includeClipboard === false ? Promise.resolve([]) : getClipboardChunks(),
  ]);

  const chunks = [
    ...diagnosticChunk(currentPath, options.diagnostics ?? []),
    ...clipboard,
    ...references,
    ...definitions,
    ...buildRecentBufferChunks(options.recentBuffers ?? []),
  ]
    .filter((chunk) => chunk.content.trim().length > 0)
    .filter((chunk) => !isCoveredCurrentFileChunk(chunk, currentPath, activeContextRange))
    .map((chunk) => truncateRetrievalChunk(chunk, maxChunkLines))
    .filter((chunk) => chunk.content.trim().length > 0);

  return prioritizePaths(fuseAndDedupRetrievalSnippets(chunks)).slice(0, Math.max(0, maxChunks));
}

/** Keep a retrieved excerpt within its line budget without changing its path or timestamp. */
export function truncateRetrievalChunk(chunk: FileChunk, maxLines: number): FileChunk {
  const lines = chunk.content.split("\n");
  if (lines.length <= maxLines) {
    return chunk;
  }

  const lineCount = Math.max(0, Math.floor(maxLines));
  return {
    ...chunk,
    end_line: Math.min(chunk.end_line, chunk.start_line + lineCount - 1),
    content: lines.slice(0, lineCount).join("\n"),
  };
}

/** Coalesce duplicate and nearby excerpts while preserving the order of first occurrence. */
export function fuseAndDedupRetrievalSnippets(snippets: FileChunk[]): FileChunk[] {
  const fused: FileChunk[] = [];

  for (const snippet of snippets) {
    if (!snippet.content.trim()) continue;

    const duplicate = fused.some(
      (existing) =>
        existing.file_path === snippet.file_path &&
        existing.start_line === snippet.start_line &&
        existing.end_line === snippet.end_line &&
        existing.content === snippet.content,
    );
    if (duplicate) continue;

    let merged = snippet;
    for (let i = 0; i < fused.length;) {
      const existing = fused[i];
      if (existing && existing.file_path === merged.file_path && rangesTouch(existing, merged)) {
        merged = mergeSnippet(existing, merged);
        fused.splice(i, 1);
        // The expanded range can now touch an earlier excerpt as well.
        i = 0;
        continue;
      }
      i++;
    }
    fused.push(merged);
  }

  return fused;
}

function rangesTouch(a: FileChunk, b: FileChunk): boolean {
  return b.start_line <= a.end_line + 1 && a.start_line <= b.end_line + 1;
}

function mergeSnippet(a: FileChunk, b: FileChunk): FileChunk {
  if (a.start_line <= b.start_line && a.end_line >= b.end_line) {
    return a;
  }
  if (b.start_line <= a.start_line && b.end_line >= a.end_line) {
    return b;
  }

  const startLine = Math.min(a.start_line, b.start_line);
  const endLine = Math.max(a.end_line, b.end_line);
  const lines = new Map<number, string>();
  addChunkLines(lines, a);
  addChunkLines(lines, b);

  const content: string[] = [];
  for (let line = startLine; line <= endLine; line++) {
    content.push(lines.get(line) ?? "");
  }

  const timestamp = Math.max(a.timestamp ?? 0, b.timestamp ?? 0);
  return {
    file_path: a.file_path,
    start_line: startLine,
    end_line: endLine,
    content: content.join("\n").trim(),
    ...(timestamp > 0 ? { timestamp } : {}),
  };
}

function addChunkLines(lines: Map<number, string>, chunk: FileChunk): void {
  chunk.content.split("\n").forEach((line, index) => {
    const absoluteLine = chunk.start_line + index;
    if (!lines.has(absoluteLine)) lines.set(absoluteLine, line);
  });
}

function isCoveredCurrentFileChunk(
  chunk: FileChunk,
  currentPath: string,
  activeRange: { startLine: number; endLine: number } | undefined,
): boolean {
  if (toUnixPath(chunk.file_path) !== currentPath) return false;
  if (!activeRange) return true;
  return chunk.start_line <= activeRange.endLine && activeRange.startLine <= chunk.end_line;
}

function prioritizePaths(chunks: FileChunk[]): FileChunk[] {
  const byPath = new Map<string, FileChunk[]>();
  for (const chunk of chunks) {
    const entries = byPath.get(chunk.file_path) ?? [];
    entries.push(chunk);
    byPath.set(chunk.file_path, entries);
  }

  const prioritized: FileChunk[] = [];
  while (byPath.size > 0) {
    for (const [path, entries] of byPath) {
      const next = entries.shift();
      if (next) prioritized.push(next);
      if (entries.length === 0) byPath.delete(path);
    }
  }
  return prioritized;
}

async function getDefinitionChunks(
  document: vscode.TextDocument,
  position: vscode.Position,
  retrievalFileLoader: RetrievalFileLoader,
  openDocumentsProvider: OpenDocumentsProvider,
): Promise<FileChunk[]> {
  try {
    const results =
      (await vscode.commands.executeCommand<
        Array<vscode.Location | vscode.LocationLink> | undefined
      >("vscode.executeDefinitionProvider", document.uri, position)) ?? [];
    const locations = results
      .map(normalizeLocation)
      .filter((location): location is vscode.Location => location !== null);
    return buildLocationChunks(
      locations,
      MAX_DEFINITION_CHUNKS,
      retrievalFileLoader,
      openDocumentsProvider,
    );
  } catch {
    return [];
  }
}

async function getReferenceChunks(
  document: vscode.TextDocument,
  position: vscode.Position,
  retrievalFileLoader: RetrievalFileLoader,
  openDocumentsProvider: OpenDocumentsProvider,
): Promise<FileChunk[]> {
  try {
    const locations =
      (await vscode.commands.executeCommand<vscode.Location[] | undefined>(
        "vscode.executeReferenceProvider",
        document.uri,
        position,
      )) ?? [];
    return buildLocationChunks(
      locations,
      MAX_REFERENCE_CHUNKS,
      retrievalFileLoader,
      openDocumentsProvider,
    );
  } catch {
    return [];
  }
}

function normalizeLocation(
  location: vscode.Location | vscode.LocationLink,
): vscode.Location | null {
  if ("uri" in location && "range" in location) {
    return new vscode.Location(location.uri, location.range);
  }
  if ("targetUri" in location && "targetRange" in location) {
    return new vscode.Location(location.targetUri, location.targetRange);
  }
  return null;
}

async function buildLocationChunks(
  locations: readonly vscode.Location[],
  maxChunks: number,
  retrievalFileLoader: RetrievalFileLoader,
  openDocumentsProvider: OpenDocumentsProvider,
): Promise<FileChunk[]> {
  const seen = new Set<string>();
  const chunks: FileChunk[] = [];
  for (const location of locations) {
    if (chunks.length >= maxChunks) break;
    const key = [location.uri.toString(), location.range.start.line, location.range.end.line].join(
      ":",
    );
    if (seen.has(key)) continue;
    seen.add(key);
    const chunk = await buildChunkFromLocation(
      location,
      retrievalFileLoader,
      openDocumentsProvider,
    );
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

async function buildChunkFromLocation(
  location: vscode.Location,
  retrievalFileLoader: RetrievalFileLoader,
  openDocumentsProvider: OpenDocumentsProvider,
): Promise<FileChunk | null> {
  try {
    const openDocuments = openDocumentsProvider();
    const targetDocument = openDocuments.find(
      (candidate) => candidate.uri.toString() === location.uri.toString(),
    );
    const source = targetDocument
      ? targetDocument.getText()
      : new TextDecoder("utf-8").decode(await retrievalFileLoader(location.uri));
    if (isFileTooLarge(source)) return null;
    const lines = source.split(/\r?\n/);
    if (lines.length === 0) return null;
    const startLine = Math.max(0, location.range.start.line - CONTEXT_LINES);
    const endLine = Math.min(lines.length - 1, location.range.end.line + CONTEXT_LINES);
    const content = lines
      .slice(startLine, endLine + 1)
      .join("\n")
      .trim();
    if (!content) return null;
    return {
      file_path: toUnixPath(location.uri.fsPath || location.uri.toString()),
      start_line: startLine + 1,
      end_line: endLine + 1,
      content,
      timestamp: Date.now(),
    };
  } catch {
    return null;
  }
}

async function getClipboardChunks(): Promise<FileChunk[]> {
  try {
    const text = (await vscode.env.clipboard.readText()).trim();
    if (!text) return [];
    const lines = text.split(/\r?\n/).slice(0, MAX_CLIPBOARD_LINES);
    const content = lines.join("\n").trim();
    if (!content) return [];
    return [
      {
        file_path: "clipboard.txt",
        start_line: 1,
        end_line: lines.length,
        content,
        timestamp: Date.now(),
      },
    ];
  } catch {
    return [];
  }
}

function diagnosticChunk(filePath: string, diagnostics: readonly vscode.Diagnostic[]): FileChunk[] {
  if (diagnostics.length === 0) return [];
  const rows = diagnostics.slice(0, 50).map((diagnostic) => {
    const line = diagnostic.range.start.line + 1;
    const column = diagnostic.range.start.character + 1;
    const severity = diagnosticSeverity(diagnostic.severity);
    return `${filePath}:${line}:${column}: ${severity}: ${diagnostic.message}`;
  });
  return [
    {
      file_path: "diagnostics",
      start_line: 1,
      end_line: rows.length,
      content: rows.join("\n"),
    },
  ];
}

function diagnosticSeverity(severity: vscode.DiagnosticSeverity): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "info";
    case vscode.DiagnosticSeverity.Hint:
      return "hint";
    default:
      return "info";
  }
}
