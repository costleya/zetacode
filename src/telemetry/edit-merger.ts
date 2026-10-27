export interface NewSideRange {
  start: number;
  end: number;
}

export interface EditableRecord {
  filepath: string;
  diff: string;
  timestamp: number;
}

const MAX_COALESCE_WINDOW_MS = 60_000;

/**
 * Parse one unified-diff hunk header and return its new-side line range.
 * Omitted counts represent one line. Zero-count ranges are represented as a
 * point at the hunk's start line so deletions still participate in grouping.
 */
export function parseNewSideRange(header: string): NewSideRange | null {
  const match = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@(?:\s.*)?$/.exec(header);
  if (!match) return null;

  const start = Number(match[1]);
  const count = match[2] === undefined ? 1 : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count)) {
    return null;
  }
  const end = count === 0 ? start : start + count - 1;
  if (!Number.isSafeInteger(end)) return null;

  return { start, end };
}

/** Parse all new-side hunk ranges in a diff, or null if any header is invalid. */
export function parseNewSideRanges(diff: string): NewSideRange[] | null {
  const ranges: NewSideRange[] = [];
  for (const line of diff.split(/\r?\n/)) {
    if (!line.startsWith("@@")) continue;

    const range = parseNewSideRange(line);
    if (!range) return null;
    ranges.push(range);
  }

  return ranges.length > 0 ? ranges : null;
}

/** Compare inclusive line ranges, optionally allowing a small intervening gap. */
export function rangesOverlap(first: NewSideRange, second: NewSideRange, maxGapLines = 0): boolean {
  if (!Number.isInteger(maxGapLines) || maxGapLines < 0) return false;
  return first.start <= second.end + maxGapLines + 1 && second.start <= first.end + maxGapLines + 1;
}

/** Whether an incoming edit belongs to the same typing burst as an older one. */
export function shouldCoalesce(incoming: EditableRecord, existing: EditableRecord): boolean {
  if (incoming.filepath !== existing.filepath) return false;
  if (Math.abs(incoming.timestamp - existing.timestamp) > MAX_COALESCE_WINDOW_MS) {
    return false;
  }

  const incomingRanges = parseNewSideRanges(incoming.diff);
  const existingRanges = parseNewSideRanges(existing.diff);
  if (!incomingRanges || !existingRanges) return false;

  return incomingRanges.some((incomingRange) =>
    existingRanges.some((existingRange) => rangesOverlap(incomingRange, existingRange, 1)),
  );
}
