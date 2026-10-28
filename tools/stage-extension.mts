import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = process.argv[3];
if (!destination) throw new Error("Usage: node tools/stage-extension.mts ROOT DESTINATION");
await mkdir(destination, { recursive: true });
for (const name of ["package.json", "out", "assets", ".vscodeignore"]) {
  await cp(path.join(root, "extension", name), path.join(destination, name), { recursive: true });
}
for (const name of ["README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
  await cp(path.join(root, name), path.join(destination, name));
}
for (const name of [
  "src",
  "pyproject.toml",
  "pylock.toml",
  ".python-version",
  "pnpm-workspace.yaml",
]) {
  await cp(path.join(root, "server", name), path.join(destination, "server", name), {
    recursive: true,
    filter: (source) => !/(?:^|\/)__pycache__(?:\/|$)|\.(?:pyc|pyo)$/.test(source),
  });
}
