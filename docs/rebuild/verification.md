# Reconstruction verification

Status: source/package checks and the foreground editor smoke comparison pass. The evidence below defines the verified behavior and performance scope; the status glyph issue found during closing review was repaired and verified in the real host. Behavior and provenance reviews have no remaining material findings within the documented scope. Source snapshot: `30226d334f835c3383e75e73eac0e40d8ea5ba1f`.

## Frozen references and build

- Reconstruction starts at accepted Sweep `fa52a26b31d755c3e3d8e1f2d857a77d39cfebbb`.
- Behavioral reference is `46fbc0a0ccafb7f6bb95a6cda9207446bc7cc070`, whose built bundle matches installed NESweep 1.2.7 after normalizing build-root labels. See [bundle comparison](bundle-comparison.md).
- Candidate VSIX: `nes-rebuild-candidate.vsix`, 876,181 bytes, SHA-256 `6973288af2d73350aff1a7dc21ac6a10c4fa1eeb5c3c4a6a522e6260e781f69a`.

## Automated checks

| Check                                           | Result                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| TypeScript suite                                | 516 tests, 31 files, all passed; 2.46 seconds                               |
| Python suite                                    | 130 passed; 2.374 seconds. Reused because runtime/test inputs are unchanged |
| Typecheck                                       | Passed, Pyright zero errors; non-blocking lint warnings recorded in logs    |
| Build and formatting                            | Passed                                                                      |
| Package layout and corpus validation            | Passed                                                                      |
| Node/Python gRPC and OpenTelemetry integrations | Both passed                                                                 |
| Package integrity                               | 32 files; valid VSIX archive                                                |
| Bundled dependency notices                      | 49 packages, matching all bundle package roots                              |
| Prompt differential                             | 8 frozen corpus prompts and 24 additional window cases match reference      |
| Independent prompt boundary checks              | 5,700 cases passed                                                          |

No coverage or duplication checker is configured. Focused watch results were used during development; the 516-test result is a separate full finite run.

## Real inference and performance

[Machine-readable results](performance-results.json) contain per-case medians and conditions. All 56 balanced warm/typing/cache pairs have identical prompts and applied text. Each condition ran four repetitions with reference-first and rebuild-first order balanced. Both clients used the same current runtime, model snapshots, settings and hardware.

| Measurement                                  | Reference |   Rebuild |
| -------------------------------------------- | --------: | --------: |
| Fresh-process first usable edit, median of 3 |  73.20 ms |  73.11 ms |
| Fresh-process complete request, median of 3  | 272.23 ms | 269.50 ms |
| Repeated result-cache request, median of 4   |  35.86 ms |  35.94 ms |
| Typing first usable edit, step 1 median      |  62.19 ms |  61.95 ms |
| Typing first usable edit, step 2 median      |  47.81 ms |  47.39 ms |
| Typing first usable edit, step 3 median      |  39.58 ms |  39.43 ms |
| Typing first usable edit, step 4 median      | 225.62 ms | 226.39 ms |

Fresh-process samples start after both models report ready with zero KV cache. They exclude model loading. Cache-hit requests skip Zeta but still call Qwen; they are not zero-RPC results. Warm per-case complete-request medians differ by roughly -0.3% to +3.2%; no material client-path latency regression was observed in this corpus. These are measured samples, not a universal latency guarantee or editor-paint measurement.

A supplementary isolated copy of the older runtime currently used by the installed extension produced identical applied outputs for all eight warm cases and four typing steps. The actual user service was left running and unchanged. The rebuild retains the newer local Qwen KV reuse and asynchronous decoding implementation.

## Semantic results

Matching output includes existing model mistakes. The reference and rebuild both produced an arbitrary diagnostic correction, an undefined Python `helper_022` call, and no correction for the malformed `greeting.` expression. Typing examples can form `value * value` even though the function is named `double`. The ordinary doubling completion and repeated-cache example produce `value * 2`. The parser/harness's applicable-edit category is not a semantic-success claim.

## Foreground editor comparison

Native Computer Use opened the installed reference and candidate in separate development windows inside the existing VS Code process. Both remained in Restricted Mode. Typing a space after `return value *` displayed `2;` in each window; Tab accepted it and saved identical document text. After undo, each extension's manual request command displayed the same suggestion. Escape removed the preview without inserting it, verified visually and against the saved document. A second paired fixture renamed a parameter from `value` to `input`: both builds displayed a highlighted off-cursor replacement in the function body, and Alt+Tab accepted identical saved text. See [UI evidence record](ui-verification.json).

Input-to-observation was 633 ms for reference and 632 ms for candidate. These single samples include automation overhead and are upper bounds, not precise first-paint measurements or a statistical UI latency comparison. Model/request latency is measured separately above. This smoke comparison supplements the broader contract, lifecycle, parser, preview and concurrency tests; it does not exercise every UI state. Experimental proposed inline presentation is disabled by default and documented as requiring Insiders with explicit proposed-API enablement; it was not exercised in this stable-host UI run.

Earlier isolated-window trials could not obtain native foreground focus and failed the installed-reference positive control too. Their diagnostic reports remain preserved; the unsuccessful experimental harness was archived under `artifacts/ui-parity/` and removed from final source. Both successful temporary development windows were closed, and the task-owned model runtime exited successfully. The original VS Code window and user model service remain running. Nothing was installed or pushed.

Closing UI review found that Chromium rejected the generated WOFF2 wrapper. The generator now emits the same independently created five glyphs as a validated TrueType font. A real candidate-host reload shows the N monogram correctly; all five glyphs also passed CoreText rendering checks. Three unused legacy artwork files were removed from the package.
