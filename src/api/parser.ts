import type { AutocompleteResponse, AutocompleteResult } from "./schemas.ts";
import { ZETA_CURSOR, ZETA_CURSOR_ECHO, ZETA_EOS, type ModelPrompt } from "./prompt.ts";

const MARKER_PATTERN = /<\|marker_(\d+)\|>/g;
const CURSOR_PATTERN = /<\|user_cursor\|>|<\|cursor\|>/g;

export type ParsedAutocompleteResult = AutocompleteResult;

interface ParsedText {
  text: string;
  cursorIndex?: number;
}

function byteOffsetToUtf16(text: string, byteOffset: number): number {
  const target = Math.max(0, Math.min(byteOffset, Buffer.byteLength(text, "utf8")));
  let bytes = 0;
  let units = 0;
  for (const character of text) {
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > target) break;
    bytes += width;
    units += character.length;
  }
  return units;
}

function removeCursorMarkers(text: string): ParsedText {
  let cursorIndex: number | undefined;
  let result = "";
  let last = 0;
  CURSOR_PATTERN.lastIndex = 0;
  for (let match = CURSOR_PATTERN.exec(text); match; match = CURSOR_PATTERN.exec(text)) {
    result += text.slice(last, match.index);
    if (cursorIndex === undefined) cursorIndex = result.length;
    last = match.index + match[0].length;
  }
  result += text.slice(last);
  return { text: result, ...(cursorIndex === undefined ? {} : { cursorIndex }) };
}

function removeInjectedDiagnostics(text: string, marker?: string, commentPrefix?: string): string {
  if (!marker || !commentPrefix) return text;
  return text
    .split("\n")
    .map((line) => {
      const index = line.lastIndexOf(marker);
      if (index < 0) return line;
      // Only remove a marker suffix when it is comment-like. This avoids
      // deleting ordinary code that happens to contain the marker phrase.
      const before = line.slice(0, index);
      const prefixIndex = before.lastIndexOf(commentPrefix);
      if (prefixIndex < 0 || before.slice(prefixIndex + commentPrefix.length).trim()) return line;
      return before.slice(0, prefixIndex).trimEnd();
    })
    .join("\n");
}

function stripStructuralNewlines(text: string): string {
  // One newline on each marker edge is framing; interior blank lines remain data.
  let result = text;
  if (result.startsWith("\r\n")) result = result.slice(2);
  else if (result.startsWith("\n")) result = result.slice(1);
  if (result.endsWith("\r\n")) result = result.slice(0, -2);
  else if (result.endsWith("\n")) result = result.slice(0, -1);
  return result;
}

function stripIntermediateMarkerFrames(text: string): string {
  return text.replace(/<\|marker_\d+\|>(?:\r\n|\n)?/g, "");
}

function splitLines(text: string): string[] {
  return text.split("\n");
}

interface TrimmedEdit {
  startByte: number;
  endByte: number;
  text: string;
  replacementPrefixBytes: number;
}

function trimCommonLines(original: string, startByte: number, replacement: string): TrimmedEdit {
  let originalContent = original;
  let endingBytes = 0;
  if (replacement.length > 0) {
    if (originalContent.endsWith("\r\n")) {
      originalContent = originalContent.slice(0, -2);
      endingBytes = 2;
    } else if (originalContent.endsWith("\n")) {
      originalContent = originalContent.slice(0, -1);
      endingBytes = 1;
    }
  }
  const oldLines = splitLines(originalContent);
  const newLines = splitLines(replacement);
  let leading = 0;
  const sharedLimit = Math.min(oldLines.length, newLines.length);
  while (
    leading < sharedLimit &&
    (oldLines[leading] ?? "").trimEnd() === (newLines[leading] ?? "").trimEnd()
  )
    leading += 1;
  let trailing = 0;
  while (
    trailing < oldLines.length - leading &&
    trailing < newLines.length - leading &&
    (oldLines[oldLines.length - trailing - 1] ?? "").trimEnd() ===
      (newLines[newLines.length - trailing - 1] ?? "").trimEnd()
  )
    trailing += 1;
  const oldPrefix = oldLines.slice(0, leading).join("\n");
  const newPrefix = newLines.slice(0, leading).join("\n");
  const oldMiddle = oldLines.slice(leading, oldLines.length - trailing);
  const newMiddle = newLines.slice(leading, newLines.length - trailing).join("\n");
  const prefixBytes = leading > 0 ? Buffer.byteLength(`${oldPrefix}\n`, "utf8") : 0;
  const replacementPrefixBytes = leading > 0 ? Buffer.byteLength(`${newPrefix}\n`, "utf8") : 0;
  const middleBytes = Buffer.byteLength(oldMiddle.join("\n"), "utf8");
  const needsLineJoin = newMiddle.length === 0 && oldMiddle.length > 0;
  const lineJoinBytes = needsLineJoin && trailing > 0 ? 1 : 0;
  const terminalEndingBytes = needsLineJoin && trailing === 0 ? endingBytes : 0;
  return {
    startByte: startByte + prefixBytes,
    endByte: startByte + prefixBytes + middleBytes + lineJoinBytes + terminalEndingBytes,
    text: newMiddle,
    replacementPrefixBytes,
  };
}

function guardRepeatedTail(text: string): string | null {
  const lines = text.split("\n");
  let firstNonblank = 0;
  while (firstNonblank < lines.length && !(lines[firstNonblank] ?? "").trim()) firstNonblank += 1;
  if (firstNonblank < lines.length) {
    const firstLine = (lines[firstNonblank] ?? "").trimEnd();
    let repeatedAtStart = 1;
    while ((lines[firstNonblank + repeatedAtStart] ?? "").trimEnd() === firstLine) {
      repeatedAtStart += 1;
    }
    if (repeatedAtStart >= 3) return null;
  }
  let tail = lines.length - 1;
  while (tail >= 0 && !(lines[tail] ?? "").trim()) tail -= 1;
  if (tail < 1) return text;
  const repeated = (lines[tail] ?? "").trimEnd();
  if (!repeated.trim()) return text;
  let first = tail;
  while (first > 0 && (lines[first - 1] ?? "").trimEnd() === repeated) first -= 1;
  const count = tail - first + 1;
  if (count < 3) return text;
  if (first === firstNonblank) return null;
  lines.splice(first + 1, count - 1);
  return lines.join("\n");
}

function sourceSlice(prompt: ModelPrompt, start: number, end: number): string {
  const bytes = Buffer.from(prompt.sourceLines.join("\n"), "utf8");
  return bytes.subarray(start, end).toString("utf8");
}

function getSpan(
  text: string,
  prompt: ModelPrompt,
): { startByte: number; endByte: number; body: string; explicitClose: boolean } | null {
  MARKER_PATTERN.lastIndex = 0;
  const matches = [...text.matchAll(MARKER_PATTERN)];
  if (matches.length === 0) {
    if (/<\|marker_/.test(text)) return null;
    const start = prompt.markerBoundaries["<|marker_1|>"]?.byteOffset;
    const end = Object.values(prompt.markerBoundaries).find(
      (boundary) => boundary.line === prompt.endLine,
    )?.byteOffset;
    if (start === undefined || end === undefined) return null;
    return { startByte: start, endByte: end, body: text, explicitClose: false };
  }

  const seen = new Set<string>();
  let previous = -1;
  for (const match of matches) {
    const token = match[0];
    const boundary = prompt.markerBoundaries[token];
    const number = Number(match[1]);
    if (!boundary || seen.has(token) || number <= previous) return null;
    seen.add(token);
    previous = number;
  }
  const first = matches[0];
  if (!first) return null;
  const openToken = first[0];
  const start = prompt.markerBoundaries[openToken]?.byteOffset;
  if (start === undefined) return null;
  if (matches.length === 1) {
    const nextBoundary = prompt.markerBoundaries[`<|marker_${Number(first[1]) + 1}|>`];
    if (!nextBoundary || nextBoundary.byteOffset < start) return null;
    const bodyStart = first.index! + first[0].length;
    return {
      startByte: start,
      endByte: nextBoundary.byteOffset,
      body: stripStructuralNewlines(text.slice(bodyStart)),
      explicitClose: false,
    };
  }
  const last = matches[matches.length - 1];
  if (!last) return null;
  const end = prompt.markerBoundaries[last[0]]?.byteOffset;
  if (end === undefined || end < start) return null;
  const bodyStart = first.index! + first[0].length;
  const bodyEnd = last.index!;
  const body = stripIntermediateMarkerFrames(text.slice(bodyStart, bodyEnd));
  return {
    startByte: start,
    endByte: end,
    body: stripStructuralNewlines(body),
    explicitClose: true,
  };
}

function isLengthTruncated(response: AutocompleteResponse): boolean {
  const reason = response.finish_reason?.toLowerCase() ?? "";
  return reason === "length" || reason.includes("max_token") || reason.includes("truncat");
}

/** Safely convert a Zeta response into a single editor-coordinate edit. */
export function parseZetaResponse(
  input: string | AutocompleteResponse,
  modelPrompt: ModelPrompt,
): ParsedAutocompleteResult | null {
  const response = typeof input === "string" ? null : input;
  if (response && isLengthTruncated(response)) return null;
  let rawText = response?.completion ?? (input as string);
  if (rawText.includes(ZETA_EOS)) rawText = rawText.slice(0, rawText.indexOf(ZETA_EOS));
  const span = getSpan(rawText, modelPrompt);
  if (!span || (!span.explicitClose && span.body.trim().length === 0)) return null;
  let body = span.body.replace(MARKER_PATTERN, "");
  const cursor = removeCursorMarkers(body);
  body = removeInjectedDiagnostics(
    cursor.text,
    modelPrompt.injectedDiagnosticMarker,
    modelPrompt.injectedDiagnosticCommentPrefix,
  );
  if (!span.explicitClose && body.trim().length === 0) return null;
  const source = modelPrompt.sourceLines.join("\n");
  const maxByte = Buffer.byteLength(source, "utf8");
  const startByte = Math.max(0, Math.min(span.startByte, maxByte));
  const endByte = Math.max(startByte, Math.min(span.endByte, maxByte));
  const original = sourceSlice(modelPrompt, startByte, endByte);
  if (!body.trim() && startByte === endByte) return null;
  const guardedBody = guardRepeatedTail(body);
  if (guardedBody === null) return null;
  body = guardedBody;
  const trimmed = trimCommonLines(original, startByte, body);
  const comparableOriginal = body.length > 0 ? original.replace(/(?:\r\n|\n)$/, "") : original;
  const normalizedOld = comparableOriginal.replace(/[\t ]+$/gm, "");
  const normalizedNew = body.replace(/[\t ]+$/gm, "");
  if (normalizedOld === normalizedNew) return null;
  if (!trimmed.text.trim() && trimmed.startByte === trimmed.endByte) return null;
  const finalStart = Math.max(0, Math.min(trimmed.startByte, maxByte));
  const finalEnd = Math.max(finalStart, Math.min(trimmed.endByte, maxByte));
  const cursorPrefix =
    cursor.cursorIndex === undefined
      ? undefined
      : removeInjectedDiagnostics(
          cursor.text.slice(0, cursor.cursorIndex),
          modelPrompt.injectedDiagnosticMarker,
          modelPrompt.injectedDiagnosticCommentPrefix,
        );
  const cursorByteOffset =
    cursorPrefix === undefined
      ? undefined
      : Buffer.byteLength(cursorPrefix, "utf8") - trimmed.replacementPrefixBytes;
  const cursorOffset =
    cursorByteOffset === undefined
      ? undefined
      : byteOffsetToUtf16(
          trimmed.text,
          Math.max(0, Math.min(cursorByteOffset, Buffer.byteLength(trimmed.text, "utf8"))),
        );
  const result: ParsedAutocompleteResult = {
    id: response?.autocomplete_id ?? "",
    startIndex: byteOffsetToUtf16(source, finalStart),
    endIndex: byteOffsetToUtf16(source, finalEnd),
    completion: trimmed.text,
    confidence: response?.confidence ?? 1,
    ...(cursorOffset === undefined ? {} : { cursorTargetOffset: cursorOffset }),
  };
  return result;
}

export { ZETA_CURSOR, ZETA_CURSOR_ECHO };
