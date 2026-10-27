# Sweep-base reconstruction port manifest

## Reference and method

- **Sweep baseline accepted by user:** `fa52a26b31d755c3e3d8e1f2d857a77d39cfebbb` (2026-02-13, `version: Bump to 0.5.0`). The first SR_team fork commit `ca153cb` is its direct child.
- **Latest pre-Aaron/middle-fork snapshot:** `cddda9326264c570a8832c026ca63e9745f2d057` (SR_team, 2026-08-18). The first Aaron commit `f256a6f` is a direct child of this snapshot.
- **Current main audited:** `46fbc0a0ccafb7f6bb95a6cda9207446bc7cc070`, Aaron’s 2026-10-27 “Refresh NESweep ribbon icons and loading frames” commit. At audit time the shared worktree remained detached at `3de40ca`; `main` was exactly one commit ahead. No branch or product files were changed.

Classification compares all tracked current files and applies `git blame -w -M -C -C` with the known reformat-only commit `352595e2f1f0ba673dfd28488f86d92040165f7c` ignored. Line ancestry classes are mechanical: **Sweep** means commit is an ancestor of `fa52a26`; **middle** means ancestor of `cddda93` but not `fa52a26` (this includes SR_team and other contributors in that interval); **post** means not an ancestor of `cddda93`. These labels describe Git history, not authorship rights. A whole-file “candidate” below means all lines resolve to Aaron-authored post-tip commits under this blame mode; it is not a legal clearance or independent-work conclusion.

## Safe-port summary

The current main tree has 133 tracked files. Compared with the accepted Sweep tree, it has 108 paths absent by name, 25 same-path files with changed blobs, and 11 Sweep paths deleted; **zero current paths are byte-identical to a Sweep path**. Therefore path absence does not imply an independently authored new file: `prompt-utils.ts`, `completion-client.ts`, `zeta2-completion.ts`, editor modules, and server files have moved/extracted lines from old paths, as shown below and in the origin JSON.

Movement-aware blame groups the 133 current paths as:

| Mechanical class                                                      | Files | Port treatment from a Sweep base                                                              |
| --------------------------------------------------------------------- | ----: | --------------------------------------------------------------------------------------------- |
| All current text lines trace to Aaron-authored post-`cddda93` commits |    55 | Whole-file line-provenance candidates, subject to dependency/generated-file checks            |
| Mixed Aaron lines with Sweep and/or middle-fork lines                 |    73 | Do not take current file wholesale; reconstruct from Sweep base and port Aaron-origin regions |
| Middle-fork-only text                                                 |     1 | Exclude: `LICENSE`                                                                            |
| Sweep-origin-only current text                                        |     2 | Use the Sweep-base version; current blobs differ, and no Aaron-origin lines were found        |
| Binary files changed since the middle fork                            |     2 | Git blame cannot classify binary content; preserve only with explicit artifact/source review  |

There are no exact current file blobs from the Sweep baseline. The two Sweep-origin-only line files are `src/utils/path.ts` and `tsconfig.json`; their current versions should not be copied over the base just because blame traces their lines to Sweep. The sole middle-only file is `LICENSE`, whose current blob matches `cddda93` and whose path does not exist at `fa52a26`.

### Whole-file line-provenance candidates

These paths have all current text lines attributed by movement-aware blame to Aaron-authored commits after `cddda93`. Start with these as whole-file candidates, then resolve their imports and generated-file inputs before integration.

**Production modules and proto/server package**

- `src/api/completion-routing.ts`
- `src/core/local-runtime.ts`
- `src/core/telemetry.ts`
- `src/services/managed-setup-status.ts`
- `tools/zeta-server/src/completion_pb2.py`
- `tools/zeta-server/src/completion_pb2.pyi`
- `tools/zeta-server/src/completion_pb2_grpc.py`
- `tools/zeta-server/src/completion_pb2_grpc.pyi`
- `tools/zeta-server/src/continuation_decoder.py`
- `tools/zeta-server/src/decoder.py`
- `tools/zeta-server/src/observability.py`
- `tools/zeta-server/src/proto/completion.proto`
- `tools/zeta-server/src/server.py`
- `tools/zeta-server/src/setup_progress.py`
- `tools/zeta-server/src/typing_contracts.py`
- `tools/zeta-server/src/unix_grpc_server.py`

**Tests and fixtures**

- `test/extension-telemetry.test.ts`
- `test/fixtures/continuation-document.ts`
- `test/fixtures/otel-python-service.py`
- `test/grpc-python-fixture.py`
- `test/grpc-python.integration.ts`
- `test/local-runtime.test.ts`
- `test/managed-setup-status.test.ts`
- `test/otel-grpc-python.integration.ts`
- `test/package-layout.test.py`
- `test/production-register.mjs`
- `tools/zeta-server/tests/test_continuation_decoder.py`
- `tools/zeta-server/tests/test_decoder.py`
- `tools/zeta-server/tests/test_grpc_server.py`
- `tools/zeta-server/tests/test_launcher.py`
- `tools/zeta-server/tests/test_observability.py`
- `tools/zeta-server/tests/test_server.py`
- `tools/zeta-server/tests/test_setup_progress.py`
- `tools/zeta-server/tests/test_unix_grpc_server.py`

**Typing support**

- `tools/zeta-server/typings/mlx_lm/__init__.pyi`
- `tools/zeta-server/typings/mlx_lm/models/__init__.pyi`
- `tools/zeta-server/typings/mlx_lm/models/cache.pyi`
- `tools/zeta-server/typings/mlx_lm/sample_utils.pyi`

**Build, repository, and package scaffolding**

- `.codex/config.toml`
- `.codex/rules/vitest-daemon.rules`
- `.codex/s-obvious-dev-plugins/state.json`
- `AGENTS.md`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `pyrightconfig.json`
- `tools/build-icon-font.mjs`
- `tools/zeta-server/.gitignore`
- `tools/zeta-server/.python-version`
- `tools/zeta-server/README.md`
- `tools/zeta-server/TRANSPORT-DECISION.md`
- `tools/zeta-server/generate-proto.sh`
- `tools/zeta-server/pyproject.toml`
- `tools/zeta-server/run.sh`
- `tools/zeta-server/uv.lock`
- `vite.config.ts`

The pure-Aaron group’s imports are not all self-contained: `src/api/completion-routing.ts` imports mixed `src/api/client.ts` and `src/api/schemas.ts`; `test/grpc-python.integration.ts` and `test/otel-grpc-python.integration.ts` import mixed `src/api/completion-client.ts`. Include those as explicit dependencies to reconstruct, not as evidence that the dependent file itself is mixed. Generated protobuf files and MLX typing stubs are Git-attributed to Aaron, but their generation inputs or external API provenance need their own review.

### Mixed files: port Aaron-origin regions only

All 73 paths below contain at least one post-tip/Aaron-attributed line and at least one earlier-origin line under movement-aware blame. Rebuild these from `fa52a26` and port only the inventoried Aaron-origin regions. Do not copy a current whole file on the basis that its path is absent from Sweep.

**Core/source modules (31)**

`src/api/client.ts`, `src/api/completion-client.ts`, `src/api/continuation.ts`, `src/api/generated/completion.ts`, `src/api/model-format.ts`, `src/api/model-provider.ts`, `src/api/prompt-utils.ts`, `src/api/retrieval-chunks.ts`, `src/api/rules.ts`, `src/api/schemas.ts`, `src/api/symbol-outline.ts`, `src/api/zeta2-completion.ts`, `src/api/zeta2-prompt.ts`, `src/core/config.ts`, `src/core/constants.ts`, `src/core/logger.ts`, `src/editor/edit-display-classifier.ts`, `src/editor/inline-edit-provider.ts`, `src/editor/jump-edit-manager.ts`, `src/editor/proposed-inline-edit.ts`, `src/editor/syntax-highlight-renderer.ts`, `src/extension/activate.ts`, `src/extension/rules-diagnostics.ts`, `src/extension/status-bar.ts`, `src/services/completion-server.ts`, `src/services/managed-local-server.ts`, `src/telemetry/document-tracker.ts`, `src/telemetry/edit-merger.ts`, `src/telemetry/edit-tracking-anchor.ts`, `src/telemetry/unified-diff.ts`, `src/utils/text.ts`.

**Tests (31)**

`test/api-client-continuation.test.ts`, `test/api-client-fim-first-grpc.test.ts`, `test/api-client-fim-first.test.ts`, `test/api-client-grpc.test.ts`, `test/api-client-model.test.ts`, `test/autocomplete-metrics.test.ts`, `test/completion-client.test.ts`, `test/completion-server.test.ts`, `test/continuation.test.ts`, `test/document-symbol-cache.test.ts`, `test/document-tracker-continuation.test.ts`, `test/document-tracker-lifecycle.test.ts`, `test/edit-display-classifier.test.ts`, `test/edit-merger.test.ts`, `test/fixtures/grpc-server.ts`, `test/inline-edit-continuation.test.ts`, `test/inline-edit-provider.test.ts`, `test/jump-edit-manager.test.ts`, `test/managed-local-server.test.ts`, `test/model-format.test.ts`, `test/model-settings.test.ts`, `test/proposed-inline-edit.test.ts`, `test/recent-changes.test.ts`, `test/retrieval-chunks.test.ts`, `test/retrieval-file-loading.test.ts`, `test/setup-vscode-mock.ts`, `test/symbol-outline.test.ts`, `test/syntax-highlight-renderer.test.ts`, `test/tracing-client.test.ts`, `test/unified-diff.test.ts`, `test/zeta2-completion.test.ts`.

**Metadata and assets (11)**

`.gitignore`, `.vscodeignore`, `CHANGELOG.md`, `README.md`, `package.json`, `assets/nesweep-glyph.svg`, `assets/nesweep-load-1.svg`, `assets/nesweep-load-2.svg`, `assets/nesweep-load-3.svg`, `assets/nesweep-load-4.svg`, `assets/nesweep.svg`.

### Middle-only and binary exceptions

- `LICENSE` is wholly middle-fork history; it was added by SR_team in `eee5020e` and is byte-identical to the latest inherited middle-fork tip. It is not part of the accepted Sweep tree.
- `assets/nesweep-icons.woff2` and `assets/nesweep.png` are binary, so line blame does not separate old and new content. Both changed in main commit `46fbc0a`; their earlier paths/blobs came from the middle-fork branding history. The new `tools/build-icon-font.mjs` is an Aaron-only text file, but this does not by itself establish origin of the binary outputs. Preserve/rebuild these artifacts only after comparing their inputs and generated output.

## Inherited file moves and cross-file origins

Movement-aware blame reports these origins in current files; these are practical warnings against treating absent paths as independent additions:

- `src/api/prompt-utils.ts` contains origins from `src/api/sweep-prompt.ts` (117 lines) and `src/api/sweep-completion.ts` (35 lines). Aaron’s `b52a589` is Git’s R020 move/extraction candidate from `sweep-prompt.ts`. Direct comparison to `cddda93:src/api/sweep-prompt.ts` gives 42 exact ordered lines; after collapsing whitespace and dropping blank lines it gives 109 ordered matches (582 vs 146 normalized nonblank lines; ~29.95% sequence ratio).
- `src/api/completion-client.ts` has blamed regions from middle-fork `llama-server-client.ts` (20), `ollama-client.ts` (12), and `client.ts` (2).
- `src/api/zeta2-completion.ts` has 86 lines traced to `src/api/sweep-completion.ts`; `src/api/zeta2-prompt.ts` has 10 to `src/api/sweep-prompt.ts`.
- `src/editor/inline-edit-provider.ts` has 233 lines traced to old `src/provider/inline-edit-provider.ts`; `src/editor/jump-edit-manager.ts` has 435 to `src/provider/jump-edit-manager.ts`.
- `src/editor/syntax-highlight-renderer.ts` traces 456 lines to `src/provider/syntax-highlight-renderer.ts`; the path was renamed in Sweep commit `9ecb684` (Git R078).
- `src/telemetry/document-tracker.ts` traces 200 lines to `src/tracking/document-tracker.ts`.
- `src/extension/activate.ts` traces 76 lines to old `src/extension.ts`; `src/services/completion-server.ts` traces to `src/services/ollama-server.ts` (30) and `src/services/local-server.ts` (9).
- New server paths under `tools/zeta-server/src/` also have post-fork move/split origins, e.g. `decoder.py` (166 lines from the earlier `tools/zeta-server/decoder.py`) and `unix_grpc_server.py` (68 from `unix_http_server.py`). These are Aaron work after the accepted baseline, but `--follow` shows path evolution across Aaron commits.

For full per-region current/origin line ranges, commit IDs, author metadata, baseline path statuses, and blame-mode results, see [`nes-gpl-main-origin-regions.json`](/private/tmp/nes-gpl-main-origin-regions.json). File-level classes are in [`nes-rebuild-port-analysis.json`](/private/tmp/nes-rebuild-port-analysis.json). The JSON is the exact port map; this markdown is the human summary.

## Current main delta from the worktree snapshot

`46fbc0a` changes eight asset paths, modifies `package.json`, and adds `tools/build-icon-font.mjs`. The generator’s 308 text lines are Aaron-only by blame. The package file is mixed (movement-aware origin counts: 110 Sweep, 192 middle-fork, 55 post-tip/Aaron lines); do not cherry-pick the commit as a whole. The SVG assets are also mixed, while the WOFF2 and PNG have no line-level provenance. If retaining this icon refresh, port the generator as a whole-file candidate, review the SVG-origin regions, and handle generated binaries as a separate artifact step.

## Practical reconstruction order

1. **Create the reconstruction from `fa52a26`** in a separate worktree/branch. Keep its files and baseline structure as the origin; do not start from `cddda93` or `main` and delete guessed SR files.
2. **Restore/build scaffolding from Aaron-only files** as needed, keeping `package.json` hunks separate because that file mixes Sweep, middle-fork, and Aaron content. The pure-Aaron `pnpm`/Vite files can be ported as full files; preserve baseline package identity until its Aaron-owned metadata is deliberately applied.
3. **Port the self-contained `tools/zeta-server` package as one group**: source, proto, generated bindings, tests, typing stubs, launch/config files. All listed text paths trace to post-tip Aaron commits; preserve internal module relationships and verify generation inputs.
4. **Reconstruct shared API paths from Sweep first**, then apply Aaron-origin regions from the JSON. Resolve moved names (`sweep-prompt`/`sweep-completion`, provider-to-editor, client/service moves) before dropping old paths. Treat `completion-routing.ts` as Aaron-only text but bring its mixed `client.ts`/`schemas.ts` dependencies through the mixed-file port process.
5. **Port editor, extension, telemetry, and rules changes by regions**, not whole current files. Their files contain substantial Sweep and/or middle-fork lines alongside Aaron changes. Keep mixed test updates aligned with those reconstructed production modules.
6. **Add Aaron-only tests and fixtures after their production dependencies**, then port Aaron-specific hunks from mixed tests. The JSON lists complete current line regions for each test.
7. **Handle metadata, README, license, and assets last.** Exclude the middle-only `LICENSE`; selectively reapply Aaron-owned README/package lines; review the SVG and icon-generation inputs; treat binary outputs separately. Do not interpret `main`’s current asset commit as making the pre-existing branded artwork a whole-file Aaron addition.

This is a Git-origin port manifest, not an implementation or legal conclusion. `git blame`, even with move/copy search, can miss rewritten code and can attribute common boilerplate to an earlier file; generated files, test fixtures, lockfiles, artwork, and dependencies still require appropriate independent review.
