import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = await mkdtemp(path.join(tmpdir(), "nesweep-vsix-"));
try {
  const commands: [string, string[]][] = [
    [process.execPath, [path.join(root, "tools/stage-extension.mts"), root, stage]],
    [
      path.join(root, "extension/node_modules/.bin/vsce"),
      ["package", "--no-dependencies", "--out", path.join(root, "nesweep.vsix")],
    ],
  ];
  for (const [command, args] of commands) {
    const result = spawnSync(command, args, { cwd: stage, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status ?? 1;
    if (process.exitCode) break;
  }
} finally {
  await rm(stage, { recursive: true, force: true });
}
