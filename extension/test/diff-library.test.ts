import { expect, test } from "vite-plus/test";

import { formatRecentChanges } from "~/api/history.ts";

test("history removes file headers but retains prefixed code and truncated hunks", () => {
  const diff = [
    "Index: src/example.ts",
    "===================================================================",
    "--- a/src/example.ts",
    "+++ b/src/example.ts",
    "@@ -1 +1 @@",
    "---counter;",
    "+++counter;",
    "...[truncated]",
  ].join("\n");

  expect(formatRecentChanges([{ path: "src/example.ts", diff }])).toBe(
    "File: src/example.ts:\n@@ -1 +1 @@\n---counter;\n+++counter;\n...[truncated]\n",
  );
});
