import { describe, expect, test } from "vite-plus/test";

import type { CompletionResult } from "~/api/completion-client.ts";
import {
  buildContinuationPrompt,
  CONTINUATION_STOP_TOKENS,
  isZetaNoEditResponse,
  parseContinuation,
} from "~/api/continuation.ts";
import type { ModelPrompt } from "~/api/prompt.ts";

function completion(text: string, finishReason = "stop"): CompletionResult {
  return { text, finishReason };
}

describe("Zeta no-edit fallback sentinel", () => {
  const prompt = {
    format: "zeta-2.1",
    boundaries: {
      "<|marker_1|>": { marker: "<|marker_1|>", line: 0, byteOffset: 0 },
      "<|marker_3|>": { marker: "<|marker_3|>", line: 8, byteOffset: 0 },
    },
  } as unknown as ModelPrompt;

  test("recognizes only repeated known marker boundaries with a complete stop", () => {
    expect(isZetaNoEditResponse(completion("<|marker_1|><|marker_1|>"), prompt)).toBe(true);
    expect(isZetaNoEditResponse(completion("<|marker_3|><|marker_3|>"), prompt)).toBe(true);
    expect(
      isZetaNoEditResponse(completion("<|marker_1|><|marker_1|><[end▁of▁sentence]>"), prompt),
    ).toBe(true);
  });

  test.each([
    ["", "stop"],
    ["<|marker_4|><|marker_4|>", "stop"],
    ["<|marker_0|><|marker_0|>", "stop"],
    ["<|marker_01|><|marker_01|>", "stop"],
    ["<|marker_1|><|marker_2|>", "stop"],
    ["<|marker_1|>code<|marker_1|>", "stop"],
    ["<|marker_1|><|marker_1|><|marker_1|>", "stop"],
    ["<|marker_1|><|marker_1|>", "length"],
    ["<|marker_1|><|marker_1|>", ""],
  ])("does not treat %j (%s) as a retry signal", (text, finish) => {
    expect(isZetaNoEditResponse(completion(text, finish), prompt)).toBe(false);
  });
});

describe("raw continuation prompt", () => {
  test("places current-file text on the two sides of the cursor without chat wrapping", () => {
    const prefix = "// 😀\n  ";
    const suffix = "\n}";

    expect(buildContinuationPrompt(prefix + suffix, prefix.length)).toBe(
      `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`,
    );
    expect(CONTINUATION_STOP_TOKENS).not.toContain("\n");
    expect(CONTINUATION_STOP_TOKENS).not.toContain("\r\n");
    expect(CONTINUATION_STOP_TOKENS).toContain("\n\n");
    expect(CONTINUATION_STOP_TOKENS).toContain("\r\n\r\n");
    expect(CONTINUATION_STOP_TOKENS).toContain("<|endoftext|>");
  });

  test("bounds context while retaining text nearest to the cursor", () => {
    const prefix = "EXCLUDED-OLD" + "a".repeat(20_000) + "NEAR-CURSOR";
    const suffix = "NEXT-LINE" + "b".repeat(20_000) + "EXCLUDED-FAR";
    const prompt = buildContinuationPrompt(prefix + suffix, prefix.length);

    expect(prompt).toContain("NEAR-CURSOR<|fim_suffix|>NEXT-LINE");
    expect(prompt).not.toContain("EXCLUDED-OLD");
    expect(prompt).not.toContain("EXCLUDED-FAR");
    expect(prompt.length).toBeLessThan(9_000);
  });
});

describe("continuation insertion normalization", () => {
  const prefix = "function demo() {\n  ";
  const document = prefix + "\n}";

  test("normalizes first-line indentation while preserving all generated closing braces", () => {
    expect(
      parseContinuation(
        completion("  const answer = 42;\n  return answer;\n}"),
        document,
        prefix.length,
      ),
    ).toBe("const answer = 42;\n  return answer;\n}");
  });

  test("preserves CRLF documents when model returns LF", () => {
    const crlfPrefix = "function demo() {\r\n  ";
    expect(
      parseContinuation(
        completion("const answer = 42;\n  return answer;"),
        crlfPrefix + "\r\n}",
        crlfPrefix.length,
      ),
    ).toBe("const answer = 42;\r\n  return answer;");
  });

  test("leaves suffix overlap intact for the provider to normalize once", () => {
    const suffix = "\n  cleanup();\n}";
    expect(parseContinuation(completion("run();" + suffix), prefix + suffix, prefix.length)).toBe(
      "run();" + suffix,
    );
  });

  test("omits a complete overlap with the document suffix", () => {
    expect(parseContinuation(completion("\n}"), document, prefix.length)).toBeNull();
  });

  test.each([
    "",
    "   \n  ",
    "<|marker_1|>return 1;<|marker_2|>",
    "<|fim_middle|>return 1;",
    "return 1;<|endoftext|>",
    "```typescript\nreturn 1;\n```",
    prefix + "return 1;",
  ])("rejects empty, control, fenced, and prefix-echo output %j", (text) => {
    expect(parseContinuation(completion(text), document, prefix.length)).toBeNull();
  });

  test("rejects a truncated multi-line completion", () => {
    expect(
      parseContinuation(completion("if (ready) {\n    run();", "length"), document, prefix.length),
    ).toBeNull();
  });

  test.each([
    ["const answer = ", "", "42;"],
    ["console.log(", ");", '"ready"'],
    ["", "existing();", "await "],
    ["const values = [", "];", "1, 2"],
    ["const x = x + ", ";", "x"],
  ])("inserts plain text between code prefix %j and suffix %j", (before, after, text) => {
    expect(parseContinuation(completion(text), before + after, before.length)).toBe(text);
  });

  test("preserves generated whitespace after a prefix containing code", () => {
    const before = "  if (ready)";
    expect(parseContinuation(completion("  run();"), before + ";", before.length)).toBe("  run();");
  });

  test("preserves a repeated short token inside an expression", () => {
    const before = "value + ";
    expect(
      parseContinuation(completion("value"), "value\n" + before + ";", 6 + before.length),
    ).toBe("value");
    expect(parseContinuation(completion("value"), before + "value", before.length)).toBe("value");
  });

  test.each([
    ["run();\n  ", "\n}", "run();"],
    ["function demo() {\n  ", "\n  cleanup();\n}", "cleanup();"],
    ["const answer = compute(); ", "", "compute();"],
  ])("rejects duplicated surrounding code for %j", (before, after, text) => {
    expect(parseContinuation(completion(text), before + after, before.length)).toBeNull();
  });

  test.each(["\u0000", "\u001b", "\u007f", "\u2028", "\u2029"])(
    "rejects unsafe control character %j at a code cursor",
    (control) => {
      const before = "const result = ";
      expect(
        parseContinuation(completion("value" + control), before + ";", before.length),
      ).toBeNull();
    },
  );
});
