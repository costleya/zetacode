import { EDIT_RANGE_PADDING_ROWS } from "~/core/constants.ts";

export type EditDisplayDecision = "INLINE" | "JUMP" | "SUPPRESS";

export type EditDisplayClassification = {
  decision: EditDisplayDecision;
  reason:
    | "far-from-cursor"
    | "before-cursor-multiline"
    | "before-cursor-single-line"
    | "different-later-line"
    | "replacement-spans-lines"
    | "single-newline-boundary"
    | "replacement-not-extended"
    | "inline-safe";
};

export type EditDisplayClassifierInput = {
  cursorLine: number;
  editStartLine: number;
  editEndLine: number;
  cursorOffset: number;
  startIndex: number;
  completion: string;
  isOnSingleNewlineBoundary: boolean;
  /** The document text covered by the edit, when the caller has it available. */
  replacedText?: string;
};

export function classifyEditDisplay(input: EditDisplayClassifierInput): EditDisplayClassification {
  const lineDifference = Math.abs(input.cursorLine - input.editStartLine);
  const isBeforeCursor = input.startIndex < input.cursorOffset;
  const hasMultilineCompletion = input.completion.includes("\n");

  const paddedStart = Math.max(0, input.editStartLine - EDIT_RANGE_PADDING_ROWS);
  const paddedEnd = input.editEndLine + EDIT_RANGE_PADDING_ROWS;
  const isFarFromCursor = input.cursorLine < paddedStart || input.cursorLine > paddedEnd;

  if (isFarFromCursor) {
    return {
      decision: "JUMP",
      reason: "far-from-cursor",
    };
  }

  if (isBeforeCursor && hasMultilineCompletion) {
    return {
      decision: "JUMP",
      reason: "before-cursor-multiline",
    };
  }

  if (isBeforeCursor) {
    return {
      decision: "JUMP",
      reason: "before-cursor-single-line",
    };
  }

  if (input.editStartLine > input.cursorLine) {
    return {
      decision: "JUMP",
      reason: "different-later-line",
    };
  }

  if (
    hasMultilineCompletion &&
    input.startIndex === input.cursorOffset &&
    input.isOnSingleNewlineBoundary &&
    lineDifference <= 1
  ) {
    return {
      decision: "SUPPRESS",
      reason: "single-newline-boundary",
    };
  }

  if (input.editEndLine > input.editStartLine) {
    return {
      decision: "JUMP",
      reason: "replacement-spans-lines",
    };
  }

  if (
    input.startIndex === input.cursorOffset &&
    input.replacedText !== undefined &&
    input.replacedText.length > 0 &&
    !input.completion.startsWith(input.replacedText)
  ) {
    return {
      decision: "JUMP",
      reason: "replacement-not-extended",
    };
  }

  return {
    decision: "INLINE",
    reason: "inline-safe",
  };
}
