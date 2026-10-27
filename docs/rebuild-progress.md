# Sweep-based reconstruction

## Acceptance requirements

- Reconstruct from accepted Sweep commit `fa52a26b31d755c3e3d8e1f2d857a77d39cfebbb`.
- Preserve Aaron's independently authored features and fixes, including Qwen KV reuse, asynchronous decoding, gRPC transport, managed local inference, FIM behavior, telemetry, and native highlighting.
- Replace middle-fork implementation and expressive assets using independently developed implementations driven by functional requirements. Do not treat formatting, extraction, or renamed symbols as new authorship.
- Preserve supported settings, commands, completion modes, editing interactions, retrieval, history, persistence, diagnostics, and cancellation behavior.
- Verify functional parity against the existing install and reference source; measure performance using realistic inference and edit application, including typing sequences and cache behavior.
- Review provenance and behavioral correctness independently before accepting the result. A green unit suite alone is insufficient.

## Pinned references

- Audited worktree: `3de40ca6d2fe6574e57e631dcc261b7f3bedcbc7`.
- Current main reference: `46fbc0a0ccafb7f6bb95a6cda9207446bc7cc070`.
- Main's additional commit updates branding assets and adds an icon-font generator; it does not change inference/editor implementation.
- Accepted Sweep source extracted to `/private/tmp/nes-rebuild-sweep-base`.
- Main reference extracted to `/private/tmp/nes-rebuild-reference`.

## Current phase

The worktree is on `codex/gpl-sweep-rebuild`, rooted at accepted Sweep `fa52a26`. Independent replacements and vetted Aaron modules are integrated. Independent source/provenance review found no remaining expressive middle-fork implementation in the reviewed source. See [the final provenance index](rebuild/final-source-provenance.md) and [verification report](rebuild/verification.md).

The full finite TypeScript suite passes 516 tests; the unchanged Python suite passes 130. Typechecking, build, formatting, packaging, package layout, corpus validation, and gRPC integrations pass. The candidate VSIX is saved under `outputs/`; it has not been installed or pushed. Source snapshot is committed as `30226d334f835c3383e75e73eac0e40d8ea5ba1f`, directly on accepted Sweep; the documentation receipt is recorded separately.

All 56 balanced warm/typing/cache pairs and three fresh-process pairs have identical prompts and applied outputs. No material source-path latency regression was observed in the tested corpus. An isolated copy of the older installed runtime also matched eight warm and four typing outputs. Real editor paint is not inferred from these results.

Actual foreground editor comparison now passes automatic ghost presentation, Tab acceptance, manual retrigger and Escape dismissal for both reference and candidate. Computer Use resolved native focus by using development windows in the existing Code process. See `docs/rebuild/ui-verification.json`. Temporary windows and the task-owned model runtime were cleaned up; the original window and model service remain running.

## Accepted snapshot

Behavior and provenance reviews found no remaining material findings in the documented scope. The missing status glyph was repaired by generating a validated TrueType font and verified in the real host. Final typecheck, build, package layout, formatting and archive integrity pass. Source snapshot `30226d334f835c3383e75e73eac0e40d8ea5ba1f` has tree `ba6e0389493edd09f87ca5c204e5cc6ba4607b5c` and accepted Sweep as its direct parent. The later documentation-only commit preserves the audit and verification receipt.

The candidate is ready for installation review. It has not been installed, pushed or published. Experimental proposed presentation and loading animation were not captured in-host; UI observation timing is not an editor-paint benchmark. These limits are recorded in the verification report.
