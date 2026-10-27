import type { AutocompleteResult } from "~/api/schemas.ts";

const MAX_LINES_PER_SIDE = 128;
const MAX_TOKENS_PER_SIDE = 1024;
const MAX_LCS_CELLS = 262_144;

interface Token {
  text: string;
  start: number;
  end: number;
}

interface EditGap {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

/**
 * Split one replacement into independent edits at unchanged text boundaries.
 * Ambiguous, oversized, cursor-targeted, and unsafe newline changes remain a
 * single edit so a conservative fallback cannot delete or misalign source.
 */
export function splitEditIntoSegments<T extends AutocompleteResult>(
  documentText: string,
  edit: T,
): T[] {
  const oldText = documentText.slice(edit.startIndex, edit.endIndex);
  const newText = edit.completion;
  if (
    !Number.isInteger(edit.startIndex) ||
    !Number.isInteger(edit.endIndex) ||
    edit.startIndex < 0 ||
    edit.endIndex < edit.startIndex ||
    edit.endIndex > documentText.length ||
    !hasNoCursorTarget(edit)
  ) {
    return [edit];
  }

  if (countLines(oldText) > MAX_LINES_PER_SIDE || countLines(newText) > MAX_LINES_PER_SIDE) {
    return [edit];
  }

  const oldTokens = tokenize(oldText);
  const newTokens = tokenize(newText);
  if (
    oldTokens.length === 0 ||
    newTokens.length === 0 ||
    oldTokens.length > MAX_TOKENS_PER_SIDE ||
    newTokens.length > MAX_TOKENS_PER_SIDE ||
    oldTokens.length * newTokens.length > MAX_LCS_CELLS
  ) {
    return [edit];
  }

  const matches = findCommonTokens(oldTokens, newTokens);
  const gaps = getEditGaps(oldTokens, newTokens, matches, oldText.length, newText.length);
  if (gaps.length < 2 || gaps.some((gap) => !isSafeGap(oldText, newText, gap, gaps))) {
    return [edit];
  }

  return gaps.map((gap) => ({
    ...edit,
    startIndex: edit.startIndex + gap.oldStart,
    endIndex: edit.startIndex + gap.oldEnd,
    completion: newText.slice(gap.newStart, gap.newEnd),
  }));
}

function countLines(text: string): number {
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\s+|[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$]+/gu;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const value = match[0];
    tokens.push({ text: value, start, end: start + value.length });
  }
  return tokens;
}

function findCommonTokens(oldTokens: Token[], newTokens: Token[]): Array<[number, number]> {
  const width = newTokens.length + 1;
  const rows = oldTokens.length + 1;
  const lengths = new Uint16Array(rows * width);

  for (let oldIndex = oldTokens.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newTokens.length - 1; newIndex >= 0; newIndex -= 1) {
      const current = oldIndex * width + newIndex;
      if (oldTokens[oldIndex]?.text === newTokens[newIndex]?.text) {
        lengths[current] = (lengths[(oldIndex + 1) * width + newIndex + 1] ?? 0) + 1;
      } else {
        lengths[current] = Math.max(
          lengths[(oldIndex + 1) * width + newIndex] ?? 0,
          lengths[oldIndex * width + newIndex + 1] ?? 0,
        );
      }
    }
  }

  const matches: Array<[number, number]> = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldTokens.length && newIndex < newTokens.length) {
    if (oldTokens[oldIndex]?.text === newTokens[newIndex]?.text) {
      matches.push([oldIndex, newIndex]);
      oldIndex += 1;
      newIndex += 1;
      continue;
    }
    const deleteScore = lengths[(oldIndex + 1) * width + newIndex] ?? 0;
    const insertScore = lengths[oldIndex * width + newIndex + 1] ?? 0;
    if (deleteScore >= insertScore) oldIndex += 1;
    else newIndex += 1;
  }
  return matches;
}

function getEditGaps(
  oldTokens: Token[],
  newTokens: Token[],
  matches: Array<[number, number]>,
  oldLength: number,
  newLength: number,
): EditGap[] {
  const gaps: EditGap[] = [];
  let oldTokenIndex = 0;
  let newTokenIndex = 0;
  let oldOffset = 0;
  let newOffset = 0;

  for (const [oldMatch, newMatch] of matches) {
    const oldAnchor = oldTokens[oldMatch];
    const newAnchor = newTokens[newMatch];
    if (!oldAnchor || !newAnchor) continue;
    if (oldTokenIndex !== oldMatch || newTokenIndex !== newMatch) {
      gaps.push({
        oldStart: oldOffset,
        oldEnd: oldAnchor.start,
        newStart: newOffset,
        newEnd: newAnchor.start,
      });
    }
    oldTokenIndex = oldMatch + 1;
    newTokenIndex = newMatch + 1;
    oldOffset = oldAnchor.end;
    newOffset = newAnchor.end;
  }

  if (oldOffset !== oldLength || newOffset !== newLength) {
    gaps.push({
      oldStart: oldOffset,
      oldEnd: oldLength,
      newStart: newOffset,
      newEnd: newLength,
    });
  }
  return gaps;
}

function isSafeGap(oldText: string, newText: string, gap: EditGap, gaps: EditGap[]): boolean {
  const oldValue = oldText.slice(gap.oldStart, gap.oldEnd);
  const newValue = newText.slice(gap.newStart, gap.newEnd);
  if (!oldValue.includes("\n") && !newValue.includes("\n")) return true;

  // A terminal insertion can safely add a new line after earlier edits. Keep
  // its newline with the insertion so applying it cannot collapse the line.
  const isFinalInsertion =
    oldValue.length === 0 &&
    newValue.length > 0 &&
    gap === gaps[gaps.length - 1] &&
    gap.newEnd === newText.length &&
    newValue.startsWith("\n");
  return isFinalInsertion;
}

function hasNoCursorTarget(edit: AutocompleteResult): boolean {
  const candidate = edit as AutocompleteResult & Record<string, unknown>;
  for (const [key, value] of Object.entries(candidate)) {
    if (/cursor|target/i.test(key) && value !== undefined && value !== null) {
      return false;
    }
  }
  return !/<\|[^|]*cursor[^|]*\|>/i.test(edit.completion);
}
