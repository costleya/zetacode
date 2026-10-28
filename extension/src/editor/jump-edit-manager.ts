import * as vscode from "vscode";
import type { AutocompleteResult } from "~/api/schemas.ts";
import { EDIT_RANGE_PADDING_ROWS } from "~/core/constants.ts";
import {
  classifyEditDisplay,
  type EditDisplayClassification,
} from "~/editor/edit-display-classifier.ts";

export class JumpEditManager {
  classifyEditDisplay(
    document: vscode.TextDocument,
    cursorPosition: vscode.Position,
    result: AutocompleteResult,
  ): EditDisplayClassification {
    const editStartLine = document.positionAt(result.startIndex).line;
    const editEndLine = document.positionAt(result.endIndex).line;
    const cursorLine = cursorPosition.line;
    const cursorOffset = document.offsetAt(cursorPosition);
    const documentText = document.getText();
    const documentLength = documentText.length;
    const atEndOfDocument = cursorOffset >= documentLength;
    const isOnSingleNewlineBoundary =
      cursorOffset > 0 &&
      !atEndOfDocument &&
      documentText[cursorOffset - 1] === "\n" &&
      documentText[cursorOffset] !== "\n";

    const paddedStart = Math.max(0, editStartLine - EDIT_RANGE_PADDING_ROWS);
    const paddedEnd = Math.min(document.lineCount - 1, editEndLine + EDIT_RANGE_PADDING_ROWS);
    const classification = classifyEditDisplay({
      cursorLine,
      editStartLine,
      editEndLine,
      cursorOffset,
      startIndex: result.startIndex,
      completion: result.completion,
      replacedText: document.getText(
        new vscode.Range(
          document.positionAt(result.startIndex),
          document.positionAt(result.endIndex),
        ),
      ),
      isOnSingleNewlineBoundary,
    });

    console.log("[zetacode] Edit display classification:", {
      cursorLine,
      editStartLine,
      editEndLine,
      cursorOffset,
      isOnSingleNewlineBoundary,
      paddedStart,
      paddedEnd,
      classification,
    });

    return classification;
  }
}
