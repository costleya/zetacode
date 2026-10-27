/** Real Node CompletionClient -> production Python CompletionService, fake decoders.
 * node --experimental-transform-types --import ./test/production-register.mjs test/grpc-python.integration.ts [python]
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { CompletionClient } from "../src/api/completion-client.ts";

const directory = await mkdtemp("/tmp/nes-py-grpc-");
const socketPath = join(directory, "service.sock");
const process = spawn(
  globalThis.process.argv[2] ?? "tools/zeta-server/.venv/bin/python",
  ["test/grpc-python-fixture.py", socketPath],
  { stdio: ["pipe", "pipe", "pipe"] },
);
let stderr = "";
process.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});
const exited = once(process, "exit");
const lines = createInterface({ input: process.stdout });
const client = new CompletionClient({ socketPath });
try {
  const ready = await Promise.race([
    once(lines, "line").then(([line]) => JSON.parse(line as string)),
    exited.then(() => {
      throw new Error(`Python fixture exited: ${stderr}`);
    }),
  ]);
  assert.equal(ready.ready, true);
  assert.deepEqual(await client.health(), {
    status: "ok",
    models: ["zeta-2.1", "qwen2.5-coder-7b-instruct"],
  });
  for (const model of ["zeta-2.1", "qwen2.5-coder-7b-instruct"]) {
    const milestones: string[] = [];
    const prompt =
      model === "zeta-2.1"
        ? "raw π <[fim-prefix]>code"
        : "<|fim_prefix|>const π = <|fim_suffix|>;<|fim_middle|>";
    const result = await client.complete({
      model,
      prompt,
      temperature: 0,
      repeatPenalty: model === "zeta-2.1" ? 1 : 1.1,
      maxTokens: 23,
      stop: ["END", "\n\n"],
      timeoutMs: 2000,
      onFirstToken: () => milestones.push("first"),
      onNoEditImpossible: () => milestones.push("impossible"),
    });
    assert.equal(result.finishReason, "stop");
    assert.equal(result.promptEvalCount, 17);
    assert.equal(result.evalCount, 3);
    assert.deepEqual(JSON.parse(result.text), {
      model: model === "zeta-2.1" ? "zeta" : "qwen",
      prompt,
      maxTokens: 23,
      stop: ["END", "\n\n"],
    });
    assert.deepEqual(milestones, model === "zeta-2.1" ? ["first", "impossible"] : []);
  }
  const controller = new AbortController();
  await assert.rejects(
    client.complete(
      {
        model: "zeta-2.1",
        prompt: "cancel-me",
        temperature: 0,
        maxTokens: 100,
        stop: [],
        timeoutMs: 2000,
        onFirstToken: () => controller.abort(),
      },
      controller.signal,
    ),
    { name: "AbortError" },
  );
  const recovered = await client.complete({
    model: "zeta-2.1",
    prompt: "recovery",
    temperature: 0,
    maxTokens: 0,
    stop: [],
    timeoutMs: 2000,
  });
  assert.equal(JSON.parse(recovered.text).maxTokens, 0);
  assert.equal(JSON.parse(recovered.text).prompt, "recovery");
  console.log(
    "Node/Python production gRPC: both models, raw options, milestones, cancellation, recovery passed",
  );
} finally {
  client.dispose();
  lines.close();
  process.stdin.end("stop\n");
  const [code] = await exited;
  await rm(directory, { recursive: true, force: true });
  assert.equal(code, 0, stderr);
}
