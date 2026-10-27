#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!["--adapter", "--out", "--build", "--environment"].includes(args[i]) || !args[i + 1])
    throw new Error("Expected --adapter, --out, --build and --environment");
  options[args[i].slice(2)] = args[i + 1];
}
for (const key of ["adapter", "out", "build", "environment"])
  if (!options[key]) throw new Error(`Missing --${key}`);
const corpusBytes = await readFile(
  fileURLToPath(new URL("../../test/parity/corpus.json", import.meta.url)),
);
const corpus = JSON.parse(corpusBytes);
const environment = JSON.parse(await readFile(options.environment, "utf8"));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const requiredEnvironment = [
  "hardware",
  "os",
  "vscode",
  "profile",
  "modelWeights",
  "runtime",
  "transport",
];
for (const key of requiredEnvironment)
  if (!environment[key]) throw new Error(`Missing environment.${key}`);
const results = [];
for (const sequence of corpus.sequences) {
  const child = spawn(options.adapter, [], { stdio: ["pipe", "pipe", "inherit"] });
  const childExit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`Adapter exited ${code}`)),
    );
  });
  child.stdin.end(`${JSON.stringify({ type: "sequence", sequence, cases: corpus.cases })}\n`);
  const messages = [];
  for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
    try {
      messages.push(JSON.parse(line));
    } catch {
      throw new Error(`${sequence.id}: invalid JSON line`);
    }
  }
  await childExit;
  if (
    messages.length !== sequence.steps.length + 1 ||
    messages.at(-1)?.type !== "done" ||
    !messages.at(-1).conditionEvidence
  )
    throw new Error(`${sequence.id}: missing results or condition evidence`);
  for (let i = 0; i < sequence.steps.length; i++) {
    const result = messages[i];
    if (result.type !== "result" || result.step !== i)
      throw new Error(`${sequence.id}: out-of-order result`);
    for (const field of [
      "prompt",
      "generated",
      "finishReason",
      "classification",
      "cacheEvidence",
      "pathEvidence",
    ])
      if (
        typeof result[field] !== "string" ||
        (field !== "prompt" && field !== "generated" && !result[field])
      )
        throw new Error(`${sequence.id}/${i}: invalid ${field}`);
    if (!["usable", "no-edit", "incorrect", "cancelled", "error"].includes(result.classification))
      throw new Error(`${sequence.id}/${i}: invalid classification`);
    if (result.classification === "incorrect" && !result.review)
      throw new Error(`${sequence.id}/${i}: incorrect classification requires review`);
    for (const field of ["completeMs", "grpcMs"])
      if (!Number.isFinite(result[field]) || result[field] < 0)
        throw new Error(`${sequence.id}/${i}: invalid ${field}`);
    if (
      result.firstUsableMs !== null &&
      (!Number.isFinite(result.firstUsableMs) || result.firstUsableMs < 0)
    )
      throw new Error(`${sequence.id}/${i}: invalid firstUsableMs`);
    if (
      !Array.isArray(result.events) ||
      !Object.hasOwn(result, "edit") ||
      !Object.hasOwn(result, "appliedText")
    )
      throw new Error(`${sequence.id}/${i}: missing edit or events`);
    if (
      result.edit !== null &&
      (!Number.isInteger(result.edit.start) ||
        !Number.isInteger(result.edit.end) ||
        result.edit.start < 0 ||
        result.edit.end < result.edit.start ||
        typeof result.edit.text !== "string")
    )
      throw new Error(`${sequence.id}/${i}: invalid edit`);
    if (result.appliedText !== null && typeof result.appliedText !== "string")
      throw new Error(`${sequence.id}/${i}: invalid appliedText`);
    results.push({
      sequence: sequence.id,
      step: i,
      case: sequence.steps[i].case,
      ...result,
      promptSha256: hash(result.prompt),
      generatedSha256: hash(result.generated),
    });
  }
  results.push({
    sequence: sequence.id,
    type: "condition",
    evidence: messages.at(-1).conditionEvidence,
  });
}
await writeFile(
  options.out,
  JSON.stringify(
    { version: 1, build: options.build, corpusSha256: hash(corpusBytes), environment, results },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
