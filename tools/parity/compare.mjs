#!/usr/bin/env node
import { readFile } from "node:fs/promises";
if (process.argv.length !== 4)
  throw new Error("Usage: node compare.mjs baseline.json rebuild.json");
const [left, right] = await Promise.all(
  process.argv.slice(2).map(async (path) => JSON.parse(await readFile(path, "utf8"))),
);
if (left.corpusSha256 !== right.corpusSha256)
  throw new Error("Corpus hashes differ; comparison invalid");
if (JSON.stringify(left.environment) !== JSON.stringify(right.environment))
  throw new Error("Environment differs; comparison invalid");
const rows = (evidence) => evidence.results.filter((x) => x.type === "result");
const a = rows(left),
  b = rows(right);
if (
  a.length !== b.length ||
  a.some((x, i) => x.sequence !== b[i].sequence || x.step !== b[i].step || x.case !== b[i].case)
)
  throw new Error("Result sequences differ; comparison invalid");
const invalid = [left, right].flatMap((run) => [
  ...run.results
    .filter((x) => x.type === "condition" && x.evidence?.achieved !== true)
    .map((x) => `${run.build}/${x.sequence}: cache condition not established`),
  ...rows(run)
    .filter((x) => x.classification === "error")
    .map((x) => `${run.build}/${x.sequence}/${x.step}: adapter error`),
]);
const summary = a.map((x, i) => ({
  sequence: x.sequence,
  step: x.step,
  case: x.case,
  samePrompt: x.promptSha256 === b[i].promptSha256,
  sameOutput: x.generatedSha256 === b[i].generatedSha256,
  sameEdit: JSON.stringify(x.edit) === JSON.stringify(b[i].edit),
  sameAppliedText: x.appliedText === b[i].appliedText,
  classification: [x.classification, b[i].classification],
  firstUsableMs: [x.firstUsableMs, b[i].firstUsableMs],
  completeMs: [x.completeMs, b[i].completeMs],
  grpcMs: [x.grpcMs, b[i].grpcMs],
}));
console.log(
  JSON.stringify(
    {
      baseline: left.build,
      rebuild: right.build,
      validComparison: invalid.length === 0,
      invalid,
      rows: summary,
      note: "Differences require independent semantic review; timing samples are observations, not a statistical conclusion.",
    },
    null,
    2,
  ),
);
