import type { CompletionResult } from "./completion-client.ts";
import type { ModelPrompt } from "./prompt.ts";
import { ZETA_EOS as ZETA2_1_EOS_MARKER } from "./prompt.ts";

export const CONTINUATION_STOP_TOKENS = [
  "\n\n",
  "\r\n\r\n",
  "<|endoftext|>",
  "<|im_end|>",
  "<|im_start|>",
  "<|fim_prefix|>",
  "<|fim_suffix|>",
  "<|fim_middle|>",
  "<|file_sep|>",
];

// A repeated *known* boundary is Zeta's explicit no-edit signal. Other
// unparseable responses must not become a request to a different model.
export function isZetaNoEditResponse(completion: CompletionResult, prompt: ModelPrompt): boolean {
  if (completion.finishReason !== "stop" || prompt.format !== "zeta-2.1") return false;
  const raw = completion.text.trim();
  const text = raw.endsWith(ZETA2_1_EOS_MARKER) ? raw.slice(0, -ZETA2_1_EOS_MARKER.length) : raw;
  const match = /^\s*<\|marker_(\d+)\|>\s*<\|marker_\1\|>\s*$/.exec(text);
  if (!match) return false;
  const boundary = Number(match[1]);
  return (
    String(boundary) === match[1] &&
    boundary >= 0 &&
    prompt.boundaries[`<|marker_${boundary}|>`] !== undefined
  );
}

export function buildContinuationPrompt(documentText: string, cursorOffset: number): string {
  const prefix = documentText.slice(Math.max(0, cursorOffset - 6000), cursorOffset);
  const suffix = documentText.slice(cursorOffset, cursorOffset + 2000);
  return `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`;
}

// Only a plain-text insertion is accepted; never interpret model
// output as replacement ranges, Markdown, or another prompt protocol.
export function parseContinuation(
  completion: CompletionResult,
  documentText: string,
  cursorOffset: number,
): string | null {
  if (completion.finishReason !== "stop") return null;
  if (!Number.isInteger(cursorOffset) || cursorOffset < 0 || cursorOffset > documentText.length) {
    return null;
  }
  let text = completion.text.replace(/\r\n/g, "\n");
  if (!text.trim()) return null;
  const hasControl = Array.from(text).some((character) => {
    const code = character.charCodeAt(0);
    return (
      (code < 32 && code !== 9 && code !== 10) || code === 127 || code === 0x2028 || code === 0x2029
    );
  });
  if (hasControl || /<\||<\[|```|~~~/.test(text)) {
    return null;
  }
  const lineStart = documentText.lastIndexOf("\n", cursorOffset - 1) + 1;
  const linePrefix = documentText.slice(lineStart, cursorOffset);
  const hasWhitespacePrefix = /^[ \t]*$/.test(linePrefix);
  if (hasWhitespacePrefix && linePrefix && text.startsWith(linePrefix)) {
    text = text.slice(linePrefix.length);
  }
  if (!text.trim()) return null;

  const suffix = documentText.slice(cursorOffset).replace(/\r\n/g, "\n");
  // The provider owns suffix-overlap trimming for every completion. Doing
  // it here too can strip a legitimate inner closing brace on the second pass.
  const candidate = text.trim();
  if (!candidate) return null;
  const prefix = documentText.slice(0, cursorOffset).replace(/\r\n/g, "\n").trimEnd();
  const previousLines = documentText.slice(0, lineStart).trimEnd();
  const previousLine = previousLines.slice(previousLines.lastIndexOf("\n") + 1).trim();
  const nextLine = suffix
    .split("\n")
    .find((line) => line.trim())
    ?.trim();
  const firstLine = candidate.split("\n")[0]?.trim() ?? "";
  if (hasWhitespacePrefix && previousLine && firstLine === previousLine) return null;
  if (candidate.length >= 8 && prefix.endsWith(candidate)) return null;
  // At a FIM cursor inside a line, repeated fragments can be intentional.
  // Compare whole neighboring lines only when the cursor has a blank suffix.
  if (
    /^[ \t]*(?:\r?\n|$)/.test(documentText.slice(cursorOffset)) &&
    nextLine &&
    (firstLine === nextLine || nextLine.startsWith(candidate))
  ) {
    return null;
  }
  const eol = documentText.includes("\r\n") ? "\r\n" : "\n";
  return text.replace(/\n/g, eol);
}
