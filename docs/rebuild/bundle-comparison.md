# Installed bundle vs pinned reference build

## Result

The installed extension bundle is byte-for-byte identical to the pinned reference build after normalizing one build-root path prefix in Rollup region comments. No application-code, dependency-code, or module-order difference remains.

- Installed bundle: 4,795,545 bytes; SHA-256 `2a7ebcffde057254f84001000c1d10fd61886dad56d7a63132b84092a3ea7815`.
- Pinned reference bundle: 4,825,527 bytes; SHA-256 `6394ca41a51f84add687630ce62a1df5fdb9f6b45164af3345d7c9e24d549a6b`.
- The reference output contains the prefix `../../../Users/costleya/.codex/worktrees/3d3b/vscode-nes/node_modules/` 526 times in `//#region` module labels. Replacing those 526 occurrences with `node_modules/` reduces it to 4,795,545 bytes and produces the exact installed SHA-256 above.
- The normalized region sequence is identical. All 33 `src/...` sections have identical labels and bodies. All 527 non-`src/` runtime/dependency sections have the same body-hash multiset; their labels differ only because the reference build records its resolved symlink path. Thus the 29,982-byte raw size delta is entirely the repeated 57-byte longer path prefix (`526 × 57`), not code or module-order changes.

This directly establishes the installed JavaScript behavior/performance baseline as the pinned reference bundle. The conclusion is based on full bundle comparison, not package version, icon hashes, or helper-file coincidence.

## Supporting source/build evidence

- `/private/tmp/nes-rebuild-reference/src` and `/Users/costleya/Work/vscode-nes/src` have no differences (`diff -rq` returned no entries).
- Canonical package metadata hash (version, package manager, scripts, dependencies, dev dependencies) is `b7dce3f50a62ca57bb049a9f57f36169639c88100eb35dc95dde063bae8039ba` in both trees.
- `pnpm-lock.yaml` is byte-identical in both trees: SHA-256 `10b5cecbe53a291640853dcce2bc15fcc3f8eedccff2de258423b5b7d8815911`.
- The reference `node_modules` is a symlink to `/Users/costleya/.codex/worktrees/3d3b/vscode-nes/node_modules`; this accounts for the build-root string embedded in dependency-region labels.
- The installed bundle has no external source map. The temporary reference directory also has no `.git` directory, so I cannot independently recover a commit ID from that directory. That does not weaken the binary equivalence result; the pinned-reference commit identifier should be recorded alongside its source tree by the owner who selected it.

## Scope and next owner

No files in the installed extension or reference tree were changed. No tests, model requests, servers, or GPU work were run. The rebuild/performance owner can use `/private/tmp/nes-rebuild-reference/out/extension.mjs` as the authoritative installed JS baseline, provided the pin identity is recorded separately. Python helper/runtime parity remains a separate question because this comparison covers the extension JS bundle only.
