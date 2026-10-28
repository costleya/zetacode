import type { AutocompleteResponse, AutocompleteResult } from "./schemas.ts";
import { ZETA_CURSOR, ZETA_CURSOR_ECHO, ZETA_EOS, type ModelPrompt } from "./prompt.ts";

const MARKER_PATTERN = /<\|marker_(\d+)\|>/g;
const CURSOR_PATTERN = /<\|user_cursor\|>|<\|cursor\|>/g;

export type ParsedAutocompleteResult = AutocompleteResult;

type ParsedText = {
  text: string;
  cursorIndex?: number;
};

function byteOffsetToUtf16(text: string, utf8ByteOffset: number): number {
  const targetByteOffset = Math.max(0, Math.min(utf8ByteOffset, Buffer.byteLength(text, "utf8")));
  let consumedByteLength = 0;
  let utf16Offset = 0;
  for (const character of text) {
    const characterByteLength = Buffer.byteLength(character, "utf8");
    if (consumedByteLength + characterByteLength > targetByteOffset) break;
    consumedByteLength += characterByteLength;
    utf16Offset += character.length;
  }
  return utf16Offset;
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

type TrimmedEdit = {
  startByteOffset: number;
  endByteOffset: number;
  text: string;
  replacementPrefixByteLength: number;
};

function trimCommonLines(
  sourceSpan: string,
  startByteOffset: number,
  replacement: string,
): TrimmedEdit {
  let comparableSource = sourceSpan;
  let sourceTerminalLineEndingBytes = 0;

  // Compare nonempty replacements without the source's terminal LF or CRLF.
  if (replacement.length > 0) {
    if (comparableSource.endsWith("\r\n")) {
      comparableSource = comparableSource.slice(0, -2);
      sourceTerminalLineEndingBytes = 2;
    } else if (comparableSource.endsWith("\n")) {
      comparableSource = comparableSource.slice(0, -1);
      sourceTerminalLineEndingBytes = 1;
    }
  }
  const sourceLines = comparableSource.split("\n");
  const replacementLines = replacement.split("\n");

  // Find the common prefix, comparing without trailing whitespace only.
  let firstChangedLine = 0;
  while (
    firstChangedLine < sourceLines.length &&
    firstChangedLine < replacementLines.length &&
    sourceLines[firstChangedLine]?.trimEnd() === replacementLines[firstChangedLine]?.trimEnd()
  ) {
    firstChangedLine += 1;
  }

  // Walk matching suffix lines backward without crossing the changed prefix.
  let sourceEndLine = sourceLines.length;
  let replacementEndLine = replacementLines.length;
  while (
    sourceEndLine > firstChangedLine &&
    replacementEndLine > firstChangedLine &&
    sourceLines[sourceEndLine - 1]?.trimEnd() ===
      replacementLines[replacementEndLine - 1]?.trimEnd()
  ) {
    sourceEndLine -= 1;
    replacementEndLine -= 1;
  }

  const unchangedSourcePrefix = sourceLines.slice(0, firstChangedLine).join("\n");
  const unchangedReplacementPrefix = replacementLines.slice(0, firstChangedLine).join("\n");
  const changedSourceLines = sourceLines.slice(firstChangedLine, sourceEndLine);
  const changedReplacementText = replacementLines
    .slice(firstChangedLine, replacementEndLine)
    .join("\n");
  const unchangedSourcePrefixBytes =
    firstChangedLine > 0 ? Buffer.byteLength(`${unchangedSourcePrefix}\n`, "utf8") : 0;
  const replacementPrefixByteLength =
    firstChangedLine > 0 ? Buffer.byteLength(`${unchangedReplacementPrefix}\n`, "utf8") : 0;
  const changedSourceByteLength = Buffer.byteLength(changedSourceLines.join("\n"), "utf8");

  // A deletion needs one LF to join a retained suffix, or the removed source ending at EOF.
  let deletionJoinByteLength = 0;
  if (changedReplacementText.length === 0 && changedSourceLines.length > 0) {
    deletionJoinByteLength = sourceEndLine < sourceLines.length ? 1 : sourceTerminalLineEndingBytes;
  }

  return {
    startByteOffset: startByteOffset + unchangedSourcePrefixBytes,
    endByteOffset:
      startByteOffset +
      unchangedSourcePrefixBytes +
      changedSourceByteLength +
      deletionJoinByteLength,
    text: changedReplacementText,
    replacementPrefixByteLength,
  };
}

function guardRepeatedTail(text: string): string | null {
  const lines = text.split("\n");
  const repeatedLineLimit = 3;
  const comparisonLines = lines.map((line) => line.trimEnd());

  // Reject output that starts by repeating its first nonblank line.
  const firstNonblankLineIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstNonblankLineIndex >= 0) {
    const firstThreeOpeningLines = comparisonLines.slice(
      firstNonblankLineIndex,
      firstNonblankLineIndex + repeatedLineLimit,
    );
    const firstLine = comparisonLines[firstNonblankLineIndex];
    if (
      firstThreeOpeningLines.length === repeatedLineLimit &&
      firstThreeOpeningLines.every((line) => line === firstLine)
    ) {
      return null;
    }
  }

  // Collapse a repeated nonblank tail to one line, unless it is the whole output.
  const lastNonblankLineIndex = lines.findLastIndex((line) => line.trim().length > 0);
  if (lastNonblankLineIndex < 1) return text;

  const repeatedTailLine = comparisonLines[lastNonblankLineIndex];
  let repeatedTailStartIndex = lastNonblankLineIndex;
  while (
    repeatedTailStartIndex > 0 &&
    comparisonLines[repeatedTailStartIndex - 1] === repeatedTailLine
  ) {
    repeatedTailStartIndex -= 1;
  }
  const repeatedTailCount = lastNonblankLineIndex - repeatedTailStartIndex + 1;
  if (repeatedTailCount < repeatedLineLimit) return text;
  if (repeatedTailStartIndex === firstNonblankLineIndex) return null;

  lines.splice(repeatedTailStartIndex + 1, repeatedTailCount - 1);
  return lines.join("\n");
}

function sourceSlice(prompt: ModelPrompt, startByteOffset: number, endByteOffset: number): string {
  const bytes = Buffer.from(prompt.sourceLines.join("\n"), "utf8");
  return bytes.subarray(startByteOffset, endByteOffset).toString("utf8");
}

function getSpan(
  text: string,
  prompt: ModelPrompt,
): {
  startByteOffset: number;
  endByteOffset: number;
  body: string;
  explicitClose: boolean;
} | null {
  MARKER_PATTERN.lastIndex = 0;
  const matches = [...text.matchAll(MARKER_PATTERN)];
  if (matches.length === 0) {
    if (/<\|marker_/.test(text)) return null;
    const start = prompt.markerBoundaries["<|marker_1|>"]?.byteOffset;
    const end = Object.values(prompt.markerBoundaries).find(
      (boundary) => boundary.line === prompt.endLine,
    )?.byteOffset;
    if (start === undefined || end === undefined) return null;
    return {
      startByteOffset: start,
      endByteOffset: end,
      body: text,
      explicitClose: false,
    };
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
      startByteOffset: start,
      endByteOffset: nextBoundary.byteOffset,
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
    startByteOffset: start,
    endByteOffset: end,
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
  // Extract the model completion and stop token, then resolve its edit span.
  const response = typeof input === "string" ? null : input;
  if (response && isLengthTruncated(response)) return null;
  let completionText = response?.completion ?? (input as string);
  const stopTokenIndex = completionText.indexOf(ZETA_EOS);
  if (stopTokenIndex >= 0) completionText = completionText.slice(0, stopTokenIndex);
  const span = getSpan(completionText, modelPrompt);
  if (!span || (!span.explicitClose && span.body.trim().length === 0)) return null;

  // Remove response-only markup while retaining the cursor's location.
  const markerFreeBody = span.body.replace(MARKER_PATTERN, "");
  const parsedCursor = removeCursorMarkers(markerFreeBody);
  const cleanedBody = removeInjectedDiagnostics(
    parsedCursor.text,
    modelPrompt.injectedDiagnosticMarker,
    modelPrompt.injectedDiagnosticCommentPrefix,
  );

  // Clamp marker byte offsets to the source, then trim unchanged lines from the edit.
  if (!span.explicitClose && cleanedBody.trim().length === 0) return null;
  const source = modelPrompt.sourceLines.join("\n");
  const sourceByteLength = Buffer.byteLength(source, "utf8");
  const spanStartByteOffset = Math.max(0, Math.min(span.startByteOffset, sourceByteLength));
  const spanEndByteOffset = Math.max(
    spanStartByteOffset,
    Math.min(span.endByteOffset, sourceByteLength),
  );
  const originalSpan = sourceSlice(modelPrompt, spanStartByteOffset, spanEndByteOffset);
  if (!cleanedBody.trim() && spanStartByteOffset === spanEndByteOffset) return null;

  const guardedBody = guardRepeatedTail(cleanedBody);
  if (guardedBody === null) return null;
  const trimmedEdit = trimCommonLines(originalSpan, spanStartByteOffset, guardedBody);
  const comparableOriginal =
    guardedBody.length > 0 ? originalSpan.replace(/(?:\r\n|\n)$/, "") : originalSpan;
  const normalizedOld = comparableOriginal.replace(/[\t ]+$/gm, "");
  const normalizedNew = guardedBody.replace(/[\t ]+$/gm, "");
  if (normalizedOld === normalizedNew) return null;

  // Map byte ranges to editor UTF-16 indices and place the cursor in the replacement.
  if (!trimmedEdit.text.trim() && trimmedEdit.startByteOffset === trimmedEdit.endByteOffset) {
    return null;
  }
  const editStartByteOffset = Math.max(0, Math.min(trimmedEdit.startByteOffset, sourceByteLength));
  const editEndByteOffset = Math.max(
    editStartByteOffset,
    Math.min(trimmedEdit.endByteOffset, sourceByteLength),
  );
  const cursorPrefix =
    parsedCursor.cursorIndex === undefined
      ? undefined
      : removeInjectedDiagnostics(
          parsedCursor.text.slice(0, parsedCursor.cursorIndex),
          modelPrompt.injectedDiagnosticMarker,
          modelPrompt.injectedDiagnosticCommentPrefix,
        );
  const cursorByteOffsetInReplacement =
    cursorPrefix === undefined
      ? undefined
      : Buffer.byteLength(cursorPrefix, "utf8") - trimmedEdit.replacementPrefixByteLength;
  const cursorTargetOffset =
    cursorByteOffsetInReplacement === undefined
      ? undefined
      : byteOffsetToUtf16(
          trimmedEdit.text,
          Math.max(
            0,
            Math.min(cursorByteOffsetInReplacement, Buffer.byteLength(trimmedEdit.text, "utf8")),
          ),
        );

  const result: ParsedAutocompleteResult = {
    id: response?.autocomplete_id ?? "",
    startIndex: byteOffsetToUtf16(source, editStartByteOffset),
    endIndex: byteOffsetToUtf16(source, editEndByteOffset),
    completion: trimmedEdit.text,
    ...(cursorTargetOffset === undefined ? {} : { cursorTargetOffset }),
  };
  return result;
}

export { ZETA_CURSOR, ZETA_CURSOR_ECHO };
