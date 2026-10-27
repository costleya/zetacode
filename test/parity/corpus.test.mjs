import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const corpus = JSON.parse(await readFile(new URL("./corpus.json", import.meta.url), "utf8"));
void test("frozen synthetic scenarios identify an unambiguous cursor and valid sequence steps", () => {
  const cases = new Map(corpus.cases.map((item) => [item.id, item]));
  assert.equal(cases.size, corpus.cases.length);
  for (const item of cases.values()) {
    assert.equal(typeof item.intent, "string");
    assert.ok(item.intent.length > 0);
    assert.equal(typeof item.text, "string");
    if (item.cursorAfter) {
      assert.notEqual(item.text.indexOf(item.cursorAfter), -1, item.id);
      assert.equal(
        item.text.indexOf(item.cursorAfter),
        item.text.lastIndexOf(item.cursorAfter),
        item.id,
      );
    } else assert.equal(item.text, "", item.id);
  }
  assert.equal(new Set(corpus.sequences.map((item) => item.id)).size, corpus.sequences.length);
  for (const sequence of corpus.sequences) {
    assert.ok(sequence.steps.length);
    for (const step of sequence.steps)
      assert.ok(cases.has(step.case), `${sequence.id}: ${step.case}`);
  }
});
