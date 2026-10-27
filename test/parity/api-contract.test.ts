import { describe, expect, it } from "vite-plus/test";
import { parseZetaResponse } from "~/api/parser.ts";
import { buildZetaPrompt } from "~/api/prompt.ts";
import type { AutocompleteRequest, AutocompleteResult } from "~/api/schemas.ts";

function request(fileContents: string, cursorPosition: number): AutocompleteRequest {
  return {
    debug_info: "api-contract-test",
    repo_name: "workspace",
    file_path: "src/example.ts",
    file_contents: fileContents,
    original_file_contents: fileContents,
    cursor_position: cursorPosition,
    recent_changes: "",
    changes_above_cursor: true,
    multiple_suggestions: true,
    file_chunks: [],
    retrieval_chunks: [],
    editor_diagnostics: [],
    recent_user_actions: [],
    use_bytes: true,
  };
}

function apply(source: string, result: AutocompleteResult | null): string {
  if (!result) return source;
  return source.slice(0, result.startIndex) + result.completion + source.slice(result.endIndex);
}

type BuiltPrompt = NonNullable<ReturnType<typeof buildZetaPrompt>>;

function markerAtLine(prompt: BuiltPrompt, line: number): string {
  const entry = Object.entries(prompt.markerBoundaries).find(
    ([, boundary]) => boundary.line === line,
  );
  if (!entry) throw new Error(`No marker boundary at source line ${line}`);
  return entry[0];
}

function filenameBlock(prompt: BuiltPrompt, filename: string): string | undefined {
  const opening = `<filename>${filename}\n`;
  const start = prompt.prompt.indexOf(opening);
  if (start < 0) return undefined;
  const contentStart = start + opening.length;
  const candidates = [
    prompt.prompt.indexOf("\n<filename>", contentStart),
    prompt.prompt.indexOf("\n<[fim-middle]>", contentStart),
  ].filter((index) => index >= 0);
  const end = candidates.length ? Math.min(...candidates) : prompt.prompt.length;
  return prompt.prompt.slice(contentStart, end);
}

function adjacentBoundaries(prompt: BuiltPrompt) {
  const entries = Object.entries(prompt.markerBoundaries).sort(
    (left, right) => left[1].line - right[1].line,
  );
  return entries.slice(0, -1).map(([startMarker, start], index) => {
    const next = entries[index + 1]!;
    return [startMarker, start, next[0], next[1]] as const;
  });
}

function assertBalancedLongWindow(language: "typescript" | "python"): void {
  const expected =
    language === "typescript"
      ? { editableStart: 30, editableEnd: 68, contextStart: 22, contextEnd: 75 }
      : { editableStart: 32, editableEnd: 67, contextStart: 24, contextEnd: 73 };
  const lines = Array.from({ length: 100 }, (_, index) =>
    language === "typescript"
      ? `const value = 0; // line ${String(index).padStart(3, "0")}`
      : `value = 0  # line ${String(index).padStart(3, "0")}`,
  );
  const source = lines.join("\n");
  const input = request(source, Buffer.byteLength(lines.slice(0, 50).join("\n"), "utf8"));
  input.file_path = language === "typescript" ? "src/window.ts" : "src/window.py";
  const tokensPerLine = Math.ceil(Buffer.byteLength(lines[50]!, "utf8") / 3);
  const prompt = buildZetaPrompt(input, {
    editableTokenBudget: tokensPerLine * 37,
    contextTokenBudget: tokensPerLine * 16,
  });
  expect(prompt).not.toBeNull();
  expect(prompt).toMatchObject({
    startLine: expected.editableStart,
    endLine: expected.editableEnd,
  });

  const rendered = prompt!.prompt;
  expect(rendered.startsWith(`<[fim-suffix]>${lines[expected.editableEnd]}\n`)).toBe(true);
  const prefixTokenIndex = rendered.indexOf("<[fim-prefix]>");
  expect(rendered.slice(0, prefixTokenIndex).endsWith(`${lines[expected.contextEnd]}\n`)).toBe(
    true,
  );
  for (let line = expected.contextStart; line <= expected.contextEnd; line += 1)
    expect(rendered).toContain(lines[line]);
  expect(rendered).not.toContain(lines[expected.contextStart - 1]);
  expect(rendered).not.toContain(lines[expected.contextEnd + 1]);
  expect(filenameBlock(prompt!, input.file_path)).toContain(lines[expected.editableStart]);
  expect(filenameBlock(prompt!, input.file_path)).toContain(lines[expected.editableEnd - 1]);
}

describe("Zeta API contract", () => {
  it("builds one FIM prompt with a contiguous marker range and the byte-positioned cursor", () => {
    const source = '// café\nconst face = "🙂x";\nkeep';
    const cursorPosition = Buffer.byteLength('// café\nconst face = "🙂', "utf8");
    const prompt = buildZetaPrompt(request(source, cursorPosition), {
      editableTokenBudget: 1,
      contextTokenBudget: 0,
    });

    expect(prompt).not.toBeNull();
    expect(prompt?.format).toBe("zeta-2.1");
    expect(prompt?.prefill).toBe("");
    expect(prompt?.stopTokens).toEqual(["<[end▁of▁sentence]>"]);
    expect(prompt?.regions).toEqual([{ startLine: 1, endLine: 2 }]);
    expect(prompt?.markerBoundaries["<|marker_1|>"]).toMatchObject({ line: 1, byteOffset: 9 });
    expect(prompt?.markerBoundaries["<|marker_2|>"]).toMatchObject({ line: 2, byteOffset: 31 });
    expect(prompt?.cursorLineByteOffset).toBe(Buffer.byteLength('const face = "🙂', "utf8"));
    expect(prompt?.prompt).toContain("<[fim-prefix]>");
    expect(prompt?.prompt).toContain("<filename>src/example.ts");
    expect(prompt?.prompt).toContain("\n<|marker_1|>\n");
    expect(prompt?.prompt).toContain("<|user_cursor|>");
    expect(prompt?.prompt).toContain('x";');
    const rendered = prompt!.prompt;
    expect(rendered.indexOf("<[fim-suffix]>")).toBeLessThan(rendered.indexOf("<[fim-middle]>"));
    expect(rendered.endsWith("<[fim-middle]>")).toBe(true);
    expect(rendered).not.toContain("<[end▁of▁sentence]>");
  });

  it("rejects malformed marker envelopes instead of treating them as direct edits", () => {
    const prompt = buildZetaPrompt(request("first\nsecond", 0), {
      editableTokenBudget: 20,
      contextTokenBudget: 0,
    });
    expect(prompt).not.toBeNull();

    const first = markerAtLine(prompt!, 0);
    const last = markerAtLine(prompt!, prompt!.endLine);
    expect(parseZetaResponse("<|marker_99|>replacement", prompt!)).toBeNull();
    expect(parseZetaResponse(`${first}a${first}b`, prompt!)).toBeNull();
    expect(parseZetaResponse(`${last}b${first}a`, prompt!)).toBeNull();
  });

  it("maps a Unicode-prefixed line edit from UTF-8 markers to UTF-16 editor offsets", () => {
    const source = "// café\nconst value = 1;\nkeep";
    const prompt = buildZetaPrompt(request(source, Buffer.byteLength("// café\n", "utf8")), {
      editableTokenBudget: 1,
      contextTokenBudget: 0,
    });
    expect(prompt).not.toBeNull();

    const start = markerAtLine(prompt!, 1);
    const end = markerAtLine(prompt!, 2);
    const result = parseZetaResponse(`${start}\nconst value = 2;\n${end}`, prompt!);

    expect(result).toMatchObject({
      startIndex: "// café\n".length,
      confidence: 1,
    });
    expect(apply(source, result)).toBe("// café\nconst value = 2;\nkeep");
  });

  it("allows explicit-boundary deletions and rejects length-truncated responses", () => {
    const deletionPrompt = buildZetaPrompt(request("remove me\n", 0), {
      editableTokenBudget: 10,
      contextTokenBudget: 0,
    });
    expect(deletionPrompt).not.toBeNull();
    const deletionStart = markerAtLine(deletionPrompt!, 0);
    const deletionEnd = markerAtLine(deletionPrompt!, deletionPrompt!.endLine);
    const deletion = parseZetaResponse(`${deletionStart}\n${deletionEnd}`, deletionPrompt!);
    expect(deletion).toMatchObject({
      startIndex: 0,
      endIndex: "remove me\n".length,
      completion: "",
    });

    const truncated = parseZetaResponse(
      {
        autocomplete_id: "truncated",
        start_index: 0,
        end_index: 9,
        completion: "replacement",
        confidence: 0.9,
        finish_reason: "length",
      },
      deletionPrompt!,
    );
    expect(truncated).toBeNull();
  });

  it("applies a middle marker span without replacing the surrounding lines", () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index}`);
    lines[16] = "before";
    lines[17] = "old";
    lines[18] = "after";
    const source = lines.join("\n");
    const cursorPosition = Buffer.byteLength(lines.slice(0, 17).join("\n"), "utf8") + 1;
    const prompt = buildZetaPrompt(request(source, cursorPosition), {
      editableTokenBudget: 100,
      contextTokenBudget: 0,
    });
    expect(prompt).not.toBeNull();

    const target = adjacentBoundaries(prompt!).find(
      ([, start, , end]) => start.line <= 17 && 17 < end.line,
    );
    expect(target).toBeDefined();
    const [startMarker, start, endMarker, end] = target!;
    const replacement = lines.slice(start.line, end.line).join("\n").replace("old", "new");
    const result = parseZetaResponse(`${startMarker}\n${replacement}${endMarker}`, prompt!);

    expect(apply(source, result)).toBe(
      lines.map((line) => (line === "old" ? "new" : line)).join("\n"),
    );
  });

  it("removes framing around intermediate block markers without adding blank lines", () => {
    const lines = Array.from({ length: 33 }, (_, index) => `filler ${index}`);
    lines[0] = "old1";
    lines[16] = "old2";
    lines[32] = "after";
    const source = lines.join("\n");
    const prompt = buildZetaPrompt(request(source, 0), {
      editableTokenBudget: 200,
      contextTokenBudget: 0,
    });
    expect(prompt).not.toBeNull();

    const first = markerAtLine(prompt!, 0);
    const second = markerAtLine(prompt!, 16);
    const third = markerAtLine(prompt!, 32);
    const result = parseZetaResponse(`${first}\nnew1\n${second}\nnew2\n${third}`, prompt!);

    expect(apply(source, result)).toBe("new1\nnew2\nafter");
  });

  it("trims shared blank lines while preserving Unicode editor offsets", () => {
    const source = "// café\n\nold\nafter";
    const prompt = buildZetaPrompt(request(source, Buffer.byteLength("// café\n\n", "utf8")), {
      editableTokenBudget: 100,
      contextTokenBudget: 0,
    });
    expect(prompt).not.toBeNull();

    const start = markerAtLine(prompt!, 0);
    const end = markerAtLine(prompt!, prompt!.endLine);
    const result = parseZetaResponse(`${start}\n// café\n\nnew\nafter${end}`, prompt!);

    expect(result).toMatchObject({
      startIndex: "// café\n\n".length,
    });
    expect(apply(source, result)).toBe("// café\n\nnew\nafter");
  });

  it("preserves CRLF line endings when applying a bounded edit", () => {
    const source = "before\r\nold\r\nafter";
    const prompt = buildZetaPrompt(request(source, Buffer.byteLength("before\r\n")), {
      editableTokenBudget: 100,
      contextTokenBudget: 0,
    });
    expect(prompt).not.toBeNull();

    const start = markerAtLine(prompt!, 0);
    const end = markerAtLine(prompt!, prompt!.endLine);
    const result = parseZetaResponse(`${start}\nbefore\r\nnew\r\nafter${end}`, prompt!);

    expect(apply(source, result)).toBe("before\r\nnew\r\nafter");
  });

  it("uses the next marker boundary to close a response with only an opening marker", () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index}`);
    lines[16] = "before";
    lines[17] = "old";
    lines[18] = "after";
    const source = lines.join("\n");
    const cursorPosition = Buffer.byteLength(lines.slice(0, 17).join("\n"), "utf8") + 1;
    const prompt = buildZetaPrompt(request(source, cursorPosition), {
      editableTokenBudget: 100,
      contextTokenBudget: 0,
    });
    expect(prompt).not.toBeNull();

    const target = adjacentBoundaries(prompt!).find(
      ([, start, , end]) => start.line <= 17 && 17 < end.line,
    );
    expect(target).toBeDefined();
    const [startMarker, start, , end] = target!;
    const replacement = lines.slice(start.line, end.line).join("\n").replace("old", "new");
    const result = parseZetaResponse(`${startMarker}\n${replacement}`, prompt!);

    expect(apply(source, result)).toBe(
      lines.map((line) => (line === "old" ? "new" : line)).join("\n"),
    );
  });

  it("removes injected inline diagnostics before returning the cursor target", () => {
    const source = "const café = 1;";
    const input = request(source, 0);
    input.editor_diagnostics = [
      {
        line: 1,
        start_offset: 0,
        end_offset: source.length,
        severity: "error",
        message: "type mismatch",
        timestamp: 0,
      },
    ];
    const prompt = buildZetaPrompt(input, {
      editableTokenBudget: 20,
      contextTokenBudget: 0,
      inlineDiagnostics: true,
      commentPrefix: "//",
      diagnosticMarker: "BUG",
      diagnosticRadius: 0,
    });
    expect(prompt).not.toBeNull();

    const start = markerAtLine(prompt!, 0);
    const end = markerAtLine(prompt!, prompt!.endLine);
    const result = parseZetaResponse(
      `${start}\nconst café = 2; // BUG (error): type mismatch<|cursor|>${end}`,
      prompt!,
    );

    expect(result).toMatchObject({
      completion: "const café = 2;",
      cursorTargetOffset: "const café = 2;".length,
    });
    expect(result?.completion).not.toContain("BUG");
  });

  it("keeps the cursor target correct when a shared prefix differs in trailing spaces", () => {
    const source = "a   \nold\n";
    const prompt = buildZetaPrompt(request(source, 0), {
      editableTokenBudget: 20,
      contextTokenBudget: 0,
    });
    expect(prompt).not.toBeNull();

    const start = markerAtLine(prompt!, 0);
    const end = markerAtLine(prompt!, prompt!.endLine);
    const result = parseZetaResponse(`${start}\na\nnew<|cursor|>\n${end}`, prompt!);

    expect(result).toMatchObject({
      cursorTargetOffset: 3,
    });
    expect(apply(source, result)).toBe("a   \nnew\n");
  });

  it("applies diagnostic message transforms without regard to case", () => {
    const affectedLine = "value = missing";
    const input = request(affectedLine, 0);
    input.editor_diagnostics = [
      {
        line: 1,
        start_offset: 8,
        end_offset: affectedLine.length,
        severity: "error",
        message: "CASE MISMATCH",
        timestamp: 0,
      },
    ];
    const prompt = buildZetaPrompt(input, {
      diagnosticMessageTransforms: [{ pattern: "case mismatch", replacement: "type mismatch" }],
    });

    expect(prompt).not.toBeNull();
    const diagnostics = filenameBlock(prompt!, "diagnostics");
    expect(diagnostics).toContain("error");
    expect(diagnostics).toContain("line 1:9");
    expect(diagnostics).toContain(affectedLine);
    expect(diagnostics).toContain("type mismatch");
    expect(diagnostics).not.toContain("CASE MISMATCH");
  });

  it("renders workspace rules and related files in named Zeta context blocks", () => {
    const input = request("print(helper())\n", 0);
    input.file_path = "src/main.py";
    input.file_chunks = [
      {
        file_path: "src/recent.py",
        start_line: 1,
        end_line: 2,
        content: "recent_value = 3",
      },
    ];
    input.retrieval_chunks = [
      {
        file_path: "src/helper.py",
        start_line: 4,
        end_line: 5,
        content: "def helper(): return 3",
      },
    ];
    const prompt = buildZetaPrompt(input, {
      workspaceRules: "Keep helper functions small.",
      editableTokenBudget: 20,
      contextTokenBudget: 0,
    });
    expect(prompt).not.toBeNull();

    expect(filenameBlock(prompt!, "context/rules")).toContain("Keep helper functions small.");
    expect(filenameBlock(prompt!, "src/helper.py")).toContain("def helper(): return 3");
    expect(filenameBlock(prompt!, "src/recent.py")).toContain("recent_value = 3");
    expect(filenameBlock(prompt!, "src/main.py")).toContain("print(helper())");
  });

  it("puts marker tokens on their own lines without adding a blank before EOF", () => {
    const prompt = buildZetaPrompt(request("value = 1;\n", 0), {
      editableTokenBudget: 1,
      contextTokenBudget: 0,
    });
    expect(prompt).not.toBeNull();
    const targetFile = filenameBlock(prompt!, "src/example.ts");
    const first = markerAtLine(prompt!, 0);
    const closing = markerAtLine(prompt!, prompt!.endLine);

    expect(targetFile).toContain(`${first}\n<|user_cursor|>value = 1;\n${closing}`);
    expect(targetFile).not.toContain(`\n\n${closing}`);
    expect(prompt?.prompt).toContain("<[fim-suffix]>\n<[fim-prefix]>");
  });

  it("balances long TypeScript editable and surrounding context windows", () => {
    assertBalancedLongWindow("typescript");
  });

  it("balances long Python editable and surrounding context windows", () => {
    assertBalancedLongWindow("python");
  });

  it("uses a hash comment prefix for Python inline diagnostics", () => {
    const source = "value = 1";
    const input = request(source, 0);
    input.editor_diagnostics = [
      {
        line: 1,
        start_offset: 0,
        end_offset: source.length,
        severity: "error",
        message: "unknown name",
        timestamp: 0,
      },
    ];
    const prompt = buildZetaPrompt(input, {
      inlineDiagnostics: true,
      commentPrefix: "#",
      diagnosticMarker: "PY_DIAGNOSTIC",
      diagnosticRadius: 0,
    });
    expect(prompt).not.toBeNull();
    expect(prompt?.prompt).toContain("# PY_DIAGNOSTIC (error): unknown name");

    const start = markerAtLine(prompt!, 0);
    const end = markerAtLine(prompt!, prompt!.endLine);
    const result = parseZetaResponse(
      `${start}\nvalue = 2 # PY_DIAGNOSTIC (error): unknown name<|cursor|>${end}`,
      prompt!,
    );

    expect(result).toMatchObject({
      completion: "value = 2",
      cursorTargetOffset: "value = 2".length,
    });
  });

  it("does not return a repeated nonblank tail as an edit", () => {
    const source = "start\nend";
    const prompt = buildZetaPrompt(request(source, 0), {
      editableTokenBudget: 20,
      contextTokenBudget: 0,
    });
    expect(prompt).not.toBeNull();

    const start = markerAtLine(prompt!, 0);
    const end = markerAtLine(prompt!, prompt!.endLine);
    const result = parseZetaResponse(
      `${start}\nfresh\nrepeated\nrepeated\nrepeated${end}`,
      prompt!,
    );

    expect(result === null || result.completion !== "fresh\nrepeated\nrepeated\nrepeated").toBe(
      true,
    );
  });
});
