import { describe, expect, test } from "vite-plus/test";

import { parseZetaResponse } from "~/api/parser.ts";
import { buildZetaPrompt } from "~/api/prompt.ts";
import type { AutocompleteRequest } from "~/api/schemas.ts";

function makeRequest(fileContents: string): AutocompleteRequest {
  return {
    debug_info: "marker-span-test",
    repo_name: "workspace",
    file_path: "src/example.ts",
    file_contents: fileContents,
    original_file_contents: fileContents,
    cursor_position: 0,
    recent_changes: "",
    changes_above_cursor: true,
    multiple_suggestions: false,
    file_chunks: [],
    retrieval_chunks: [],
    editor_diagnostics: [],
    recent_user_actions: [],
    use_bytes: true,
  };
}

function promptFor(fileContents: string, cursorPosition = 0, editableTokenBudget = 1_000) {
  const request = makeRequest(fileContents);
  request.cursor_position = cursorPosition;
  const prompt = buildZetaPrompt(request, {
    editableTokenBudget,
    contextTokenBudget: 0,
  });
  if (!prompt) throw new Error("expected a valid Zeta prompt");
  return prompt;
}

function apply(source: string, completion: ReturnType<typeof parseZetaResponse>): string {
  if (!completion) throw new Error("expected a parsed edit");
  return (
    source.slice(0, completion.startIndex) +
    completion.completion +
    source.slice(completion.endIndex)
  );
}

describe("Zeta marker spans", () => {
  test("uses an interior boundary pair and removes boundaries inside the replacement", () => {
    const lines = [
      "opening",
      "one",
      "two",
      "three",
      "four",
      "",
      "old one",
      "old two",
      "one",
      "two",
      "three",
      "",
      "old three",
      "old four",
      "one",
      "two",
      "three",
      "",
      "closing",
      "later",
      "tail one",
      "tail two",
      "tail three",
      "tail four",
    ];
    const source = lines.join("\n");
    const result = parseZetaResponse(
      "<|marker_2|>new one\nnew two\n<|marker_3|>new three\nnew four\n<|marker_4|>",
      promptFor(source),
    );

    expect(apply(source, result)).toBe(
      [
        ...lines.slice(0, 6),
        "new one",
        "new two",
        "new three",
        "new four",
        ...lines.slice(18),
      ].join("\n"),
    );
  });

  test("applies an interior replacement without changing surrounding lines", () => {
    const source = "before\nold\nafter";
    const result = parseZetaResponse(
      "<|marker_1|>new<|marker_2|>",
      promptFor(source, Buffer.byteLength("before\n", "utf8"), 1),
    );

    expect(apply(source, result)).toBe("before\nnew\nafter");
  });

  test("keeps intentional blank lines when applying a multi-line replacement", () => {
    const source = "before\nold\nafter";
    const result = parseZetaResponse(
      "<|marker_1|>new first\n\nnew second\n<|marker_2|>",
      promptFor(source, Buffer.byteLength("before\n", "utf8"), 1),
    );

    expect(apply(source, result)).toBe("before\nnew first\n\nnew second\nafter");
  });

  test("preserves CRLF in a multi-line replacement", () => {
    const source = "before\r\nold\r\nafter";
    const result = parseZetaResponse(
      "<|marker_1|>new first\r\nnew second\r\n<|marker_2|>",
      promptFor(source, Buffer.byteLength("before\r\n", "utf8"), 1),
    );

    expect(apply(source, result)).toBe("before\r\nnew first\r\nnew second\r\nafter");
  });
});
