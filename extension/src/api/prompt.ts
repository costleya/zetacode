import {
  DEFAULT_EDITABLE_TOKEN_BUDGET,
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  DEFAULT_DIAGNOSTIC_RADIUS_LINES,
  DEFAULT_RELATED_CHUNK_LIMIT,
} from "~/core/constants.ts";
import type { AutocompleteRequest, EditorDiagnostic, FileChunk } from "./schemas.ts";

export const ZETA_FORMAT = "zeta-2.1" as const;
export const ZETA_EOS = "<[end▁of▁sentence]>";
export const ZETA_CURSOR = "<|user_cursor|>";
export const ZETA_CURSOR_ECHO = "<|cursor|>";

export type PromptOptions = {
  commentPrefix?: string;
  diagnosticRadius?: number;
  inlineDiagnostics?: boolean;
  diagnosticMarker?: string;
  diagnosticMessageTransforms?: Array<{ pattern: string; replacement: string }>;
  editableTokenBudget?: number;
  contextTokenBudget?: number;
  relatedChunkLimit?: number;
};

export type PromptBoundary = {
  marker: string;
  line: number;
  byteOffset: number;
};

export type ModelPrompt = {
  prompt: string;
  format: typeof ZETA_FORMAT;
  prefill: "";
  stopTokens: string[];
  startLine: number;
  endLine: number;
  regions: Array<{ startLine: number; endLine: number }>;
  sourceLines: string[];
  lineByteStarts: number[];
  cursorLine: number;
  cursorLineByteOffset: number;
  markerBoundaries: Record<string, PromptBoundary>;
  /** @deprecated Use markerBoundaries. */
  boundaries: Record<string, PromptBoundary>;
  injectedDiagnosticMarker?: string;
  injectedDiagnosticCommentPrefix?: string;
};

function splitSource(text: string): { lines: string[]; starts: number[] } {
  const lines = text.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += Buffer.byteLength(line, "utf8") + 1;
  }
  return { lines, starts };
}

function byteOffsetToUtf16(text: string, byteOffset: number): number {
  const target = Math.max(0, byteOffset);
  let bytes = 0;
  let utf16 = 0;
  for (const character of text) {
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > target) break;
    bytes += width;
    utf16 += character.length;
  }
  return utf16;
}

function tokens(text: string): number {
  return text ? Math.ceil(Buffer.byteLength(text, "utf8") / 3) : 0;
}

function rangeTokens(lines: string[], start: number, end: number): number {
  return tokens(lines.slice(start, end).join("\n"));
}

function selectWindow(
  lines: string[],
  cursorLine: number,
  budget: number,
): { start: number; end: number } {
  if (lines.length === 0) return { start: 0, end: 0 };
  let start = cursorLine;
  let end = cursorLine + 1;
  const cap = Math.max(1, Math.floor(budget));
  let preferBelow = false;
  while (start > 0 || end < lines.length) {
    const above = start > 0 ? rangeTokens(lines, start, cursorLine) : Number.POSITIVE_INFINITY;
    const below =
      end < lines.length ? rangeTokens(lines, cursorLine + 1, end) : Number.POSITIVE_INFINITY;
    const takeAbove = above < below || (above === below && !preferBelow);
    const candidates = takeAbove ? ["above", "below"] : ["below", "above"];
    let expanded = false;
    for (const side of candidates) {
      if (side === "above" && start > 0 && rangeTokens(lines, start - 1, end) <= cap) {
        start -= 1;
        preferBelow = true;
        expanded = true;
        break;
      }
      if (side === "below" && end < lines.length && rangeTokens(lines, start, end + 1) <= cap) {
        end += 1;
        preferBelow = false;
        expanded = true;
        break;
      }
    }
    if (!expanded) break;
  }
  return { start, end };
}

function selectBlockBoundaries(lines: string[], start: number, end: number): number[] {
  const boundaries = [start];
  let blockStart = start;
  for (let line = start; line < end; line += 1) {
    const blockLineCount = line - blockStart + 1;
    const isLastLine = line + 1 >= end;
    const hardSplit = blockLineCount >= 16;
    const blankLineSplit =
      blockLineCount >= 6 && end - line - 1 >= 6 && !(lines[line] ?? "").trim();
    if (!isLastLine && (hardSplit || blankLineSplit)) {
      boundaries.push(line + 1);
      blockStart = line + 1;
    }
  }
  boundaries.push(end);
  return boundaries;
}

function cleanDiagnosticMessage(
  message: string,
  transforms: PromptOptions["diagnosticMessageTransforms"],
): string {
  let result = message
    .replace(/\s*\(Quick Fix(?:es)? available\)\.?\s*$/i, "")
    .replace(/\s*;?\s*suggested replacement:.*$/i, "")
    .trim();
  for (const transform of transforms ?? []) {
    try {
      result = result.replace(new RegExp(transform.pattern, "gi"), transform.replacement);
    } catch {
      // A user-supplied malformed regular expression should not fail prompting.
    }
  }
  return result.trim();
}

function relevantDiagnostics(
  diagnostics: EditorDiagnostic[],
  cursorLine: number,
  radius: number,
): EditorDiagnostic[] {
  const hasCursorError = diagnostics.some(
    (diagnostic) => diagnostic.line === cursorLine + 1 && diagnostic.severity === "error",
  );
  return diagnostics
    .filter((diagnostic) => {
      if (radius > 0 && Math.abs(diagnostic.line - 1 - cursorLine) > radius) return false;
      return !hasCursorError || diagnostic.line - 1 <= cursorLine;
    })
    .slice(0, 15);
}

function renderChunk(chunk: FileChunk): string {
  const content = chunk.content.trim();
  if (!content) return "";
  return `<filename>${chunk.file_path}\n${content}`;
}

function lineStartUtf16Offsets(lines: string[]): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return starts;
}

function renderDiagnosticBlock(
  diagnostics: EditorDiagnostic[],
  fileContents: string,
  lines: string[],
  useBytes: boolean,
  commentPrefix: string,
  transforms: PromptOptions["diagnosticMessageTransforms"],
): string {
  if (diagnostics.length === 0) return "";
  const starts = lineStartUtf16Offsets(lines);
  const linesOfText = [`${commentPrefix} FIXME: Fix these issues:`];
  for (const diagnostic of diagnostics) {
    const lineIndex = Math.max(0, Math.min(lines.length - 1, diagnostic.line - 1));
    const offset = useBytes
      ? byteOffsetToUtf16(fileContents, diagnostic.start_offset)
      : diagnostic.start_offset;
    const line = lines[lineIndex] ?? "";
    const column = Math.max(
      1,
      Math.min(line.replace(/\r$/, "").length + 1, offset - (starts[lineIndex] ?? 0) + 1),
    );
    const message = cleanDiagnosticMessage(diagnostic.message, transforms);
    const code = diagnostic.code ? ` [${diagnostic.code}]` : "";
    linesOfText.push(
      `${commentPrefix} [${diagnostic.severity}] line ${diagnostic.line}:${column}${code}: ${message}`,
    );
    if (line.trim()) linesOfText.push(`${commentPrefix}   ${line.replace(/\r$/, "")}`);
  }
  return `<filename>diagnostics\n${linesOfText.join("\n")}`;
}

function selectRelatedChunks(
  request: AutocompleteRequest,
  startLine: number,
  endLine: number,
  limit: number,
): FileChunk[] {
  const current = request.file_path;
  const chunks = [...request.retrieval_chunks, ...request.file_chunks].filter((chunk) => {
    if (!chunk.content.trim()) return false;
    if (chunk.file_path !== current) return true;
    return chunk.end_line < startLine || chunk.start_line > endLine;
  });
  const seen = new Set<string>();
  const result: FileChunk[] = [];
  for (const chunk of chunks) {
    const key = `${chunk.file_path}\0${chunk.start_line}\0${chunk.end_line}\0${chunk.content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(chunk);
    if (result.length >= Math.max(0, limit)) break;
  }
  return result;
}

function inlineDiagnosticByLine(
  diagnostics: EditorDiagnostic[],
  options: PromptOptions,
): Map<number, string[]> {
  const byLine = new Map<number, string[]>();
  for (const diagnostic of diagnostics) {
    const message = cleanDiagnosticMessage(diagnostic.message, options.diagnosticMessageTransforms);
    const code = diagnostic.code ? ` [${diagnostic.code}]` : "";
    const rendered = `(${diagnostic.severity})${code}: ${message}`;
    const line = diagnostic.line - 1;
    byLine.set(line, [...(byLine.get(line) ?? []), rendered]);
  }
  return byLine;
}

/** Build a single Zeta 2.1 FIM prompt and retain exact source boundary metadata. */
export function buildZetaPrompt(
  request: AutocompleteRequest,
  options: PromptOptions = {},
): ModelPrompt | null {
  if (
    typeof request.file_path !== "string" ||
    !request.file_path.trim() ||
    typeof request.file_contents !== "string" ||
    typeof request.recent_changes !== "string" ||
    !Array.isArray(request.file_chunks) ||
    !Array.isArray(request.retrieval_chunks) ||
    !Array.isArray(request.editor_diagnostics) ||
    !Number.isFinite(request.cursor_position) ||
    request.cursor_position < 0
  )
    return null;

  const { lines, starts } = splitSource(request.file_contents);
  if (lines.length === 0) return null;
  const cursorBytes = Math.min(
    request.cursor_position,
    Buffer.byteLength(request.file_contents, "utf8"),
  );
  let cursorLine = 0;
  for (let index = 0; index < starts.length; index += 1) {
    if ((starts[index] ?? 0) <= cursorBytes) cursorLine = index;
    else break;
  }
  cursorLine = Math.max(0, Math.min(lines.length - 1, cursorLine));
  const cursorLineByteOffset = Math.max(0, cursorBytes - (starts[cursorLine] ?? 0));
  const cursorChar = byteOffsetToUtf16(lines[cursorLine] ?? "", cursorLineByteOffset);
  const edit = selectWindow(
    lines,
    cursorLine,
    options.editableTokenBudget ?? DEFAULT_EDITABLE_TOKEN_BUDGET,
  );
  while (
    edit.end > edit.start + 1 &&
    edit.end - 1 !== cursorLine &&
    !(lines[edit.end - 1] ?? "").trim()
  ) {
    edit.end -= 1;
  }
  const contextCap = Math.max(
    0,
    Math.floor(options.contextTokenBudget ?? DEFAULT_CONTEXT_TOKEN_BUDGET),
  );
  let contextStart = edit.start;
  let contextEnd = edit.end;
  let preferBelowContext = false;
  const getContextTokens = (start: number, end: number) =>
    rangeTokens(lines, start, edit.start) + rangeTokens(lines, edit.end, end);
  while (contextStart > 0 || contextEnd < lines.length) {
    const above =
      contextStart > 0 ? rangeTokens(lines, contextStart, edit.start) : Number.POSITIVE_INFINITY;
    const below =
      contextEnd < lines.length
        ? rangeTokens(lines, edit.end, contextEnd)
        : Number.POSITIVE_INFINITY;
    const takeAbove = above < below || (above === below && !preferBelowContext);
    const candidates = takeAbove ? ["above", "below"] : ["below", "above"];
    let expanded = false;
    for (const side of candidates) {
      if (
        side === "above" &&
        contextStart > 0 &&
        getContextTokens(contextStart - 1, contextEnd) <= contextCap
      ) {
        contextStart -= 1;
        preferBelowContext = true;
        expanded = true;
        break;
      }
      if (
        side === "below" &&
        contextEnd < lines.length &&
        getContextTokens(contextStart, contextEnd + 1) <= contextCap
      ) {
        contextEnd += 1;
        preferBelowContext = false;
        expanded = true;
        break;
      }
    }
    if (!expanded) break;
  }
  if (contextStart < edit.start && /^\s/.test(lines[contextStart] ?? "")) {
    const nextBlank = lines.findIndex((line, index) => index >= contextStart && !line.trim());
    if (nextBlank >= contextStart && nextBlank < edit.start) contextStart = nextBlank;
  }
  while (
    contextEnd < lines.length &&
    (lines[contextEnd] ?? "").trim() &&
    /^\s/.test(lines[contextEnd] ?? "")
  ) {
    contextEnd += 1;
  }
  const boundaries: Record<string, PromptBoundary> = {};
  const blockBoundaries = selectBlockBoundaries(lines, edit.start, edit.end);
  for (const [index, line] of blockBoundaries.entries()) {
    const marker = `<|marker_${index + 1}|>`;
    boundaries[marker] = {
      marker,
      line,
      byteOffset:
        line < starts.length
          ? (starts[line] ?? 0)
          : Buffer.byteLength(request.file_contents, "utf8"),
    };
  }
  const selectedDiagnostics = relevantDiagnostics(
    request.editor_diagnostics ?? [],
    cursorLine,
    options.diagnosticRadius ?? DEFAULT_DIAGNOSTIC_RADIUS_LINES,
  );
  const inline = options.inlineDiagnostics === true;
  const inlineByLine = inline
    ? inlineDiagnosticByLine(selectedDiagnostics, options)
    : new Map<number, string[]>();
  const sections: string[] = [];
  const commentPrefix = options.commentPrefix ?? "//";
  const related = selectRelatedChunks(
    request,
    contextStart,
    contextEnd - 1,
    options.relatedChunkLimit ?? DEFAULT_RELATED_CHUNK_LIMIT,
  )
    .map(renderChunk)
    .filter(Boolean);
  sections.push(...related);
  if (request.recent_changes.trim())
    sections.push(`<filename>edit_history\n${request.recent_changes.trim()}`);
  if (request.symbol_outline?.trim())
    sections.push(`<filename>symbol_outline\n${request.symbol_outline.trim()}`);
  if (!inline && selectedDiagnostics.length) {
    const diagnostics = renderDiagnosticBlock(
      selectedDiagnostics,
      request.file_contents,
      lines,
      request.use_bytes,
      commentPrefix,
      options.diagnosticMessageTransforms,
    );
    if (diagnostics) sections.push(diagnostics);
  }
  const inlineText = (line: number) => {
    const diagnostics = inlineByLine.get(line) ?? [];
    if (diagnostics.length === 0) return "";
    const commentPrefix = options.commentPrefix ?? "//";
    const marker = options.diagnosticMarker ?? "Diagnostic";
    return `${commentPrefix} ${marker} ${diagnostics.join("; ")}`;
  };
  const editableLines: string[] = [];
  const markerAtLine = new Map(
    blockBoundaries.slice(0, -1).map((line, index) => [line, `<|marker_${index + 1}|>`]),
  );
  const hasTrailingEmptyLine = request.file_contents.endsWith("\n");
  for (let line = edit.start; line < edit.end; line += 1) {
    const marker = markerAtLine.has(line) ? (markerAtLine.get(line) ?? "") : "";
    const sourceLine = lines[line] ?? "";
    const annotation = inlineText(line);
    const decoratedLine = annotation ? `${sourceLine} ${annotation}` : sourceLine;
    if (marker) editableLines.push(marker);
    if (hasTrailingEmptyLine && line === lines.length - 1 && line !== cursorLine) continue;
    if (line === cursorLine) {
      editableLines.push(
        `${decoratedLine.slice(0, cursorChar)}${ZETA_CURSOR}${decoratedLine.slice(cursorChar)}`,
      );
    } else {
      editableLines.push(decoratedLine);
    }
  }
  const closingMarker = boundaries[`<|marker_${blockBoundaries.length}|>`]?.marker ?? "";
  editableLines.push(closingMarker);
  const suffixLines = lines.slice(edit.end, contextEnd);
  while (suffixLines.length > 0 && !(suffixLines[0] ?? "").trim()) suffixLines.shift();
  if (hasTrailingEmptyLine && suffixLines.at(-1) === "") suffixLines.pop();
  const prefixContextLines = lines.slice(contextStart, edit.start);
  const activeFileLines = [...prefixContextLines, ...editableLines];
  const suffix = suffixLines.join("\n");
  const prefixContext = sections.length ? `${sections.join("\n\n")}\n\n` : "";
  const prompt = `<[fim-suffix]>${suffix ? `${suffix}\n` : "\n"}<[fim-prefix]>${prefixContext}<filename>${request.file_path}\n${activeFileLines.join("\n")}\n<[fim-middle]>`;
  return {
    prompt,
    format: ZETA_FORMAT,
    prefill: "",
    stopTokens: [ZETA_EOS],
    startLine: edit.start,
    endLine: edit.end,
    regions: [{ startLine: edit.start, endLine: edit.end }],
    sourceLines: lines,
    lineByteStarts: starts,
    cursorLine,
    cursorLineByteOffset,
    markerBoundaries: boundaries,
    boundaries,
    ...(inline
      ? {
          injectedDiagnosticMarker: options.diagnosticMarker ?? "Diagnostic",
          injectedDiagnosticCommentPrefix: options.commentPrefix ?? "//",
        }
      : {}),
  };
}
