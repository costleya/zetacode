import type { RecentChange } from "./schemas.ts";

export interface RecentChangesOptions {
  maxCharacters?: number;
  maxEvents?: number;
}

const DEFAULT_MAX_CHARACTERS = 12_000;
const DEFAULT_MAX_EVENTS = 6;

/**
 * Render recent edits for the autocomplete request without allowing history to
 * grow the prompt without bound. Inputs are expected newest first; output is
 * chronological so the model reads the older event before the newer one.
 */
export function formatRecentChanges(
  changes: readonly RecentChange[],
  options: RecentChangesOptions = {},
): string {
  const maxCharacters = Math.max(0, Math.floor(options.maxCharacters ?? DEFAULT_MAX_CHARACTERS));
  const maxEvents = Math.max(0, Math.floor(options.maxEvents ?? DEFAULT_MAX_EVENTS));
  if (maxCharacters === 0 || maxEvents === 0) return "";

  const events = changes
    .map((change) => ({
      path: change.path.trim(),
      diff: cleanDiff(change.diff),
    }))
    .filter((change) => change.path.length > 0 && change.diff.length > 0)
    .slice(0, maxEvents);

  const selectedNewestFirst: string[] = [];
  let used = 0;
  for (const event of events) {
    const text = `File: ${event.path}:\n${event.diff}\n`;
    if (used + text.length <= maxCharacters) {
      selectedNewestFirst.push(text);
      used += text.length;
      continue;
    }

    // Always allow the newest event through, even when it alone exceeds the
    // budget. Keep its header and the most useful beginning of the diff.
    if (selectedNewestFirst.length === 0) {
      const header = `File: ${event.path}:\n`;
      if (header.length >= maxCharacters) return header.slice(0, maxCharacters);
      const remaining = maxCharacters - header.length;
      return `${header}${event.diff.slice(0, remaining)}`;
    }
    break;
  }

  return selectedNewestFirst.reverse().join("");
}

function cleanDiff(diff: string): string {
  return diff
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("Index:") &&
        !line.startsWith("===") &&
        !line.startsWith("---") &&
        !line.startsWith("+++"),
    )
    .join("\n")
    .trim();
}
