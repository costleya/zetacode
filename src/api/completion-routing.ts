import type { AutocompleteInput } from "./client.ts";
import type { AutocompleteResult } from "./schemas.ts";

export type CompletionRoute = "fim-first" | "zeta-first";

// This is deliberately a syntax/history heuristic, not semantic intent detection.
// Any uncertain edit stays with the model that can replace existing code.
export function classifyCompletionRoute(input: AutocompleteInput): CompletionRoute {
  const text = input.document.getText();
  const original = input.originalContent;
  const cursor = input.document.offsetAt(input.position);
  const actions = input.userActions.filter((action) => action.action_type !== "CURSOR_MOVEMENT");
  const lastAction = actions.at(-1);
  if (lastAction && !["INSERT_CHAR", "INSERT_SELECTION"].includes(lastAction.action_type)) {
    return "zeta-first";
  }
  // Tracker history is newest first. The file-open originalContent is useful
  // context for Zeta, but is not the snapshot immediately before this edit.
  const recent = input.recentChanges.find(
    (change) => change.path.replace(/\\/g, "/") === input.document.fileName.replace(/\\/g, "/"),
  );
  let latestInsertionAtCursor = false;
  if (recent) {
    if (recent.diff.includes("...[truncated]")) return "zeta-first";
    const removed = recent.diff
      .split("\n")
      .filter((line) => /^-(?!--)/.test(line))
      .map((line) => line.slice(1))
      .join("\n");
    const inserted = recent.diff
      .split("\n")
      .filter((line) => /^\+(?!\+\+)/.test(line))
      .map((line) => line.slice(1))
      .join("\n");
    // Tracker diffs can contain just changed characters; unified line diffs
    // can also repeat the whole old line for an insertion. Handle both.
    let common = 0;
    while (common < removed.length && removed[common] === inserted[common]) common++;
    const growth = inserted.length - removed.length;
    if (
      growth <= 0 ||
      removed.slice(common) !== inserted.slice(common + growth) ||
      /\b(function|def|class|interface|type)\b|^\s*\w+\s*[:?]/m.test(removed)
    ) {
      return "zeta-first";
    }
    const delta = inserted.slice(common, common + growth);
    latestInsertionAtCursor = text.slice(0, cursor).endsWith(delta);
  }
  let start = 0;
  while (start < original.length && original[start] === text[start]) start++;
  const added = text.length - original.length;
  if (
    !latestInsertionAtCursor &&
    text !== original &&
    (added <= 0 || start + added !== cursor || original.slice(start) !== text.slice(cursor))
  ) {
    return "zeta-first";
  }
  // Inserting into an existing identifier is usually a rename or correction.
  if (/\w/.test(text[cursor] ?? "")) return "zeta-first";
  if (insideCommentOrString(text.slice(0, cursor))) return "zeta-first";
  const lineStart = text.lastIndexOf("\n", cursor - 1) + 1;
  const prefix = text.slice(lineStart, cursor);
  const suffix = text.slice(cursor).split(/\r?\n/, 1)[0] ?? "";
  if (!/^[\s)}\];,]*$/.test(suffix)) return "zeta-first";
  const beforeLine = text.slice(0, lineStart).trimEnd();
  const previousLine = beforeLine.slice(beforeLine.lastIndexOf("\n") + 1).trim();
  if (!prefix.trim()) {
    return /[{:]$/.test(previousLine) ? "fim-first" : "zeta-first";
  }
  // Signatures and property declarations can imply follow-up edits elsewhere.
  if (
    /\b(function|class|interface|type|def)\b/.test(prefix) ||
    /^\s*(?:public |private |protected |readonly |static )*\w+\s*[:?]/.test(prefix)
  )
    return "zeta-first";
  if (/[;{}]\s*$/.test(prefix)) return "zeta-first";
  return /(?:\breturn\s+|\bthrow\s+|(?:const|let|var)\s+\w+\s*=|[=+*/,(.:?[-])/.test(prefix)
    ? "fim-first"
    : "zeta-first";
}

export function isMeaningfulZetaUpgrade(
  results: AutocompleteResult[],
  fim: AutocompleteResult[],
  documentText: string,
): boolean {
  if (
    !results.length ||
    results.some(
      (result) =>
        !Number.isInteger(result.startIndex) ||
        !Number.isInteger(result.endIndex) ||
        result.startIndex < 0 ||
        result.endIndex < result.startIndex ||
        result.endIndex > documentText.length ||
        /<\||```/.test(result.completion),
    )
  )
    return false;
  const substantive = (text: string) => text.replace(/\s/g, "");
  const fimText = fim.map((result) => result.completion).join("");
  return results.some((result) => {
    const old = documentText.slice(result.startIndex, result.endIndex);
    let start = 0;
    while (start < old.length && old[start] === result.completion[start]) start++;
    let end = old.length;
    let replacementEnd = result.completion.length;
    while (
      end > start &&
      replacementEnd > start &&
      old[end - 1] === result.completion[replacementEnd - 1]
    ) {
      end--;
      replacementEnd--;
    }
    return (
      substantive(old.slice(start, end)).length > 0 &&
      substantive(old) !== substantive(result.completion) &&
      !(result.startIndex === fim[0]?.startIndex && result.completion === fimText)
    );
  });
}

// A small lexical guard avoids treating operators inside prose as code intent.
function insideCommentOrString(prefix: string): boolean {
  let quote = "";
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < prefix.length; i++) {
    const character = prefix[i];
    const next = prefix[i + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
    } else if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        i++;
      }
    } else if (quote) {
      if (character === "\\") i++;
      else if (character === quote) quote = "";
    } else if ((character === "/" && next === "/") || character === "#") {
      lineComment = true;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      i++;
    } else if (character === "'" || character === '"' || character === "`") {
      quote = character;
    }
  }
  return !!quote || lineComment || blockComment;
}
