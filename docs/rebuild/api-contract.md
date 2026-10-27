# API behavior contract for an independent rebuild

This document describes observable API and feature behavior for the current extension. It is a functional specification, not an implementation recipe. It contains no source excerpts or pseudocode. It separates protocol requirements from current product choices so a replacement can choose independent internals while keeping the same user and server behavior.

## Scope and integration boundary

The rebuild scope is the middle-fork API behavior that supplies Zeta 2.1 prompts, parses model edits, and gathers optional history, retrieval, symbol, rules, and diagnostic context. The accepted Sweep baseline remains the starting point for unrelated API behavior.

Current-main integrations outside that rebuild scope must continue to work:

- Completion transport is the managed local gRPC client. API callers provide a prompt, model parameters, deadline, optional trace context, cancellation signal, and token/no-edit callbacks; they receive streamed completion events summarized as a `CompletionResult`.
- The current local Qwen continuation/FIM route may publish an insertion result before the Zeta result. It is guarded by document-version/text identity, eligibility, cancellation, and the shared request deadline. It may be disabled by the caller. Keep its result shape (`source: "continuation"`) and callback behavior compatible.
- The identical-prompt result cache described below stores completed results. It is separate from the later Qwen FIM model KV-cache reuse: do not conflate or remove either feature when implementing the other.

## Public request and result shapes

The API request carries:

- Debug and repository identity: `debug_info`, `repo_name`, optional `branch`.
- Active document: normalized `file_path`, current `file_contents`, prior `original_file_contents`, cursor byte offset, and `changes_above_cursor`.
- Edit history: `recent_changes` as text.
- Context excerpts: `file_chunks` and `retrieval_chunks`, each with path, start/end line, content, and optional timestamp.
- Optional compact `symbol_outline` text.
- `editor_diagnostics` with one-based line, document offsets, severity label, message, timestamp, and optional diagnostic code.
- `recent_user_actions` with enumerated action kind, line, offset, path, and time.
- `multiple_suggestions` and `use_bytes` flags.

The public completion response contains an autocomplete identifier, start/end document offsets, replacement text, confidence, optional elapsed time and finish reason, optional cursor target within replacement text, and optional additional completion records. The client-facing result uses UTF-16 editor offsets. The server-facing request declares byte offsets. Conversion between the two coordinate systems is part of the API contract.

`FileChunk` is the shared wire shape. Existing producers do not use one consistent line-base convention: recent-buffer excerpts can start at zero, while LSP-derived excerpts are one-based. A replacement should either retain producer-specific conversions at established boundaries or resolve and migrate this deliberately; do not silently assume the schema itself fixes the convention.

## Zeta 2.1 prompt and response protocol

### Protocol invariants

- The selected model format is Zeta 2.1. Prompt output is one FIM completion string; `prefill` is empty.
- The prompt uses `<[fim-prefix]>`, `<[fim-middle]>`, `<[fim-suffix]>`, and `<[end▁of▁sentence]>`, plus `<filename>`, numbered `<|marker_N|>` boundaries, and `<|user_cursor|>`. Preserve their exact public spellings and protocol roles. The parser also accepts `<|cursor|>` as a cursor echo in responses.
- The editable document area is one contiguous line range containing the cursor. Numbered boundaries subdivide that range; they are not independent editable windows. Each marker number maps to an absolute document line boundary.
- A valid model edit may begin at any numbered boundary and close at a later boundary. Intermediate boundary markers may occur inside the replacement span. The response parser must map the selected boundaries to byte-offset document edits.
- Numbered markers must not be used as stop sequences because the completion needs to return its closing boundary. The current `<[end▁of▁sentence]>` end-of-sequence marker is the stop condition.
- A model response marked as length-truncated is rejected as unsafe for edit application.

### Prompt composition behavior

Prompt input is an `AutocompleteRequest` plus prompt options: workspace rules, comment prefix, diagnostic radius, inline-diagnostic toggle and marker, message transforms, editable/context budgets, and related-chunk cap.

The prompt includes the active file and may include rules, recent buffers/retrieval, edit history, symbol outline, and diagnostics. Empty optional sections are omitted. The present layout places a context suffix before the FIM prefix; within the prefix, it keeps workspace rules and related context before edit history, outline, diagnostics, and the cursor file. This order is an observed model/prefix-cache choice, not a Zeta wire requirement; change only with an explicit prompt-quality decision.

The editable and surrounding context windows are contiguous and line-aligned. The cursor line remains in the editable range, including when it alone exceeds the nominal budget. A line provider reporting zero lines yields empty ranges; however, the prompt builder splits an empty document into one blank line, so an empty VS Code document can behave as a one-line document. Preserve or deliberately resolve this distinction. Cursor positions and prompt lines must handle UTF-8 byte offsets without splitting the document’s line boundaries. Current defaults are 350 estimated editable tokens and 150 context tokens, estimated at three UTF-8 bytes per token; these are tunable product defaults, not protocol constants.

`ModelPrompt` returned to the parser includes the rendered prompt, format, stop tokens, window bounds, region list, full undecorated source lines with byte starts, cursor-line byte offsets, optional marker-boundary mapping, and optional injected-diagnostic cleanup metadata. Context statistics are observational character counts and must not affect edit mapping.

### Diagnostics in prompts

Diagnostics are rendered either in a diagnostics context section or inline on their source lines, depending on the inline toggle. The structured form can be restricted to a radius around the cursor; current default radius is 12 lines and current maximum count is 15. A nonpositive radius currently means no radius filter. Inline and structured modes must not emit the same diagnostics twice.

Messages have built-in cleanup for IDE-only quick-fix suffixes and common “suggested replacement” phrasing. User-configured regex replacements run after built-ins, in declared order; invalid patterns are ignored without aborting prompt generation. Diagnostic codes, when present, remain available as stable context even if a model rewrites the message.

Inline diagnostics are appended with the document language’s comment prefix and a configurable marker phrase. Before computing edits, remove injected marker suffixes from model-returned lines. A cleanup step must tolerate missing metadata, missing marker text, and model output that does not contain the marker. It should leave unrelated user-authored comments intact.

### Window and content boundaries

- Clamp out-of-range cursor lines to a valid document line. A zero-line provider yields empty windows, while the normal empty-document prompt path may supply one blank line; specify the intended behavior at this boundary.
- A negative/zero editable budget is normalized so the cursor line still has a representable window. A zero context budget may yield no surrounding lines.
- Source lines are retained undecorated for diff mapping even when rendered prompt lines include inline diagnostics.
- Newline-terminated EOF and the split-lines trailing empty element must not shift marker-to-line mapping or create a spurious edit.

## Response parsing and edit mapping

The parser returns either no edit or one response for the selected marker span. It must reject malformed marker-bearing output rather than applying marker text to a guessed region. Current safeguards include rejecting unknown, duplicated, reversed, or non-increasing boundary sequences. A single opening marker is accepted as a compatibility case when a server removes the closing marker; an unmarked response may be treated as a direct replacement for the primary range. If marker tokens appear but do not form a valid span, the direct-replacement fallback is unsafe and must not run.

Within a valid span:

- Strip the model EOS token and structural marker newlines while retaining intentional blank lines.
- Remove intermediate numbered markers from replacement content.
- An empty replacement is a deletion only when an explicit closing boundary makes the edit span unambiguous. Empty output without a closing boundary is rejected as potentially truncated.
- Ignore a replacement that is unchanged after trailing-whitespace normalization. Trim common unchanged leading/trailing lines so the resulting edit covers only the changed region.
- Map insertions to a zero-width start offset, deletions to the original span, and replacements to the changed text. Offsets sent to the completion API are UTF-8 byte offsets; convert them to UTF-16 indices before returning editor results.
- Accept the trained cursor marker and the supported alternate cursor echo. Use the first marker to set the post-edit cursor target, remove all marker text from the replacement, and omit the target if none is present.
- Remove injected diagnostic suffixes before comparing old and new lines. Reject a response whose cleaned replacement is empty and whose range is zero-width.
- Current repetition protection can truncate a repeated nonblank line tail or reject a response that starts with repetition. This is a quality safeguard, not a public protocol rule; replacements may use a different safeguard if results remain safe.

If response mapping produces no edits, the API returns the available continuation result if that route already published one; otherwise it returns no result. Cursor-prefix normalization must not make the editor discard the original post-cursor tail when the server returns a replacement beginning before the cursor.

## Edit-history feature

History input is a list of path/diff records. The server-facing `recent_changes` field is text; current formatting adds a per-file header and removes common unified-diff metadata lines. The configured character budget and a six-event cap limit the rendered section. The current request selects recent events, renders them chronologically, and may evict older records or truncate the only surviving record to fit. These selection details are product policy, not protocol requirements. Preserve the broad user intent: recent useful edits appear within a bounded prompt budget, and a large history cannot make the request unbounded.

## Recent buffers and retrieval context

### Recent buffers

Recent-buffer entries are filtered for files exceeding the established file-size guard. Entries already carrying a selected line range retain that range/content. Full-buffer entries are projected to an initial excerpt of at most 30 lines. Path, line bounds, content, and optional modification time become `FileChunk` fields.

### Definition/reference retrieval

Definitions and references are queried from VS Code providers. Definition results may be `Location` or `LocationLink`; links must be normalized or skipped when required target data is absent. Duplicate locations are coalesced, provider failures and file-read failures contribute no chunk, and per-provider chunk counts are capped (currently six definitions and six usages).

For each result, use an already-open target document when available; otherwise load bytes from the workspace file system and decode them. Build a context excerpt around the target range (currently nine lines above and below), bounded by file limits. Empty excerpts are omitted. Keep paths normalized and preserve reported source line bounds consistently with the `FileChunk` convention.

Same-file retrieval that overlaps the active cursor context is excluded to avoid repeating visible prompt text. If no active context range exists, same-file retrieval is currently excluded. Retrieved chunks are truncated according to a limit derived from the editable-context setting; blank content is removed. Touching/overlapping snippets from the same file may be fused, exact duplicates omitted, and total results capped (currently 16).

Clipboard context is optional and currently enabled by default. A nonempty clipboard is represented as `clipboard.txt`, limited to 20 lines, and included in related context. Clipboard read errors or empty content produce no chunk.

The prompt builder applies a second related-context cap (currently five by default). It omits blank chunks and current-file chunks already covered by the local context range. It prefers LSP retrieval to recent buffers, aims to include multiple file paths before a second excerpt from one path, and reserves room for a clipboard excerpt when available. Deterministic lexical ordering is configurable and currently disabled by default. Exact ranking, merge strategy, and tie-breaking are implementation choices; preserve the requested signals and avoid duplicate/noisy context.

### Diagnostics attached to the request

Editor diagnostic line numbers are one-based, severity is one of `error`, `warning`, `info`, or `hint`, and stable diagnostic codes are optional strings. When an error exists on the cursor line, the current client removes diagnostics below the cursor to reduce cascade noise, then limits the count to 15. Whether a future design keeps this filter is a model-quality policy; if kept, retain the behavior that above-cursor diagnostics remain eligible.

There is a coordinate ambiguity to resolve: the request declares byte offsets, while VS Code’s `offsetAt` produces UTF-16 code-unit offsets; prompt rendering later compares diagnostic offsets with UTF-8 byte line starts. The replacement must establish and test one diagnostic-offset convention, especially for non-ASCII text, before treating these values as stable. Do not assume this contract resolves the existing mismatch.

## Symbol-outline feature

The outline input supports both hierarchical document symbols and flat symbol-information entries. The provider may return no symbols, fail, or be slow. Outline acquisition is optional and must not delay autocomplete: stale/missing entries can be returned while refresh runs asynchronously. Apply a bounded cache per document URI, deduplicate refreshes, accept a refresh only for the document version requested, and use timeout/backoff so an unhealthy language server does not create unbounded work. On save, an enabled outline may be refreshed. Current defaults disable the feature; the current cache cap is 16 entries, provider timeout two seconds, and retry backoff 30 seconds.

The output is a bounded text summary identifying the symbol containing the cursor plus nearby context symbols. It supports common containers/callables as well as fields, properties, variables, constants, enum members, and type parameters because providers vary in what they expose. Empty input or a zero limit yields an empty string. Current implementation sanitizes/truncates names and details and ranks nearby items by proximity, then emits source line numbers. Exact labels, sorting tie-breaks, path separator, and clipping lengths are output choices rather than protocol mandates; keep the summary concise, stable enough for prompt use, and useful when providers return flat or partial trees.

## Workspace rules

Rules live at `.vscode/nes-<languageId>.md` under the document’s workspace folder. Unsupported language IDs, documents outside a workspace, missing files, empty content, and read/stat errors yield no rules. Known comment prefixes are used to wrap each rule line as a language comment before prompt insertion; blank lines remain comment-only lines and the result ends on a line boundary. The current extension warns when a rules document exceeds the configurable 3,000-character default, but the prompt loader reads the full trimmed file rather than truncating it at that limit. A cache may be keyed by file modification time; failed/missing files should not cause expensive repeated reads on every completion. The exact supported-language table, warning policy, and cache invalidation mechanism are product choices, but file path and visible commented-rule behavior are user-facing expectations.

## Identical-prompt completed-result reuse

When enabled (currently disabled by default), an identical-prompt cache may reuse a prior completed `CompletionResult`. The current identity includes model, full prompt text, temperature, max tokens, and stop tokens. Entries expire after a configurable TTL (currently five seconds) and are bounded to 32 entries per client. Cache hit/miss must not change result semantics; it must not return expired results. This is completed-output memoization, not model KV-cache reuse.

## Required boundary cases

- Invalid request data is not sent to the model; prompt preparation reports no request.
- Missing workspace, provider exceptions, unavailable files, empty optional context, and unsupported symbol data degrade to omitted context rather than failing the completion.
- Cancellation stops in-flight work and prevents stale results from being applied. Results prepared against a changed document version/text are discarded where the route requires snapshot identity.
- File-size and line-count guards apply before prompt construction.
- Empty/whitespace-only history, rules, clipboard, diagnostic sections, and retrieval excerpts are omitted.
- Unicode before the cursor or inside edited content must preserve byte/UTF-16 mapping. Non-ASCII diagnostic offsets remain an explicit issue until their convention is corrected.
- EOF without a final newline, empty files, one-line files, a cursor on the final line, and ranges at document boundaries must not create invalid marker mappings or phantom edits.
- Insertions, replacements, and deletions all produce valid offsets and replacement text; a malformed or truncated response must not be converted into an edit over the wrong range.

## Protocol mandates versus current choices

| Area          | Preserve as contract                                                                                                            | Current choice that may be redesigned independently                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Server schema | Field names/types, byte-offset request declaration, response edit fields, chunk/diagnostic/action shapes                        | Optional extra fields, logging, debug metadata wording                                            |
| Zeta prompt   | Zeta 2.1 FIM token spellings/roles, one contiguous editable area, valid marker-to-line mapping, cursor marker and EOS semantics | Token-budget estimate, line expansion policy, context section order, prompt labels and whitespace |
| Parsing       | Safe boundary mapping, reject malformed marker envelopes, handle insert/replace/delete, map byte offsets to editor offsets      | Repetition heuristic, whitespace normalization, exact diff trimming strategy                      |
| Retrieval     | Relevant definitions/references and visible context can be represented as chunks; no invalid/empty chunks                       | Ranking, dedup/fusion, excerpt sizes, stable ordering, counts, clipboard preference               |
| Symbols       | Optional bounded structural context from flat or hierarchical provider results; never block completion                          | Which symbol kinds, ranking, text layout, caps, cache implementation                              |
| Rules         | Workspace-scoped language rules affect prompt context as commented text                                                         | Prefix table, TTL/cache mechanism, maximum length                                                 |
| Cache         | If enabled, only equivalent requests can reuse a nonexpired completed result                                                    | Key representation, eviction data structure, TTL default                                          |

## Known unresolved decisions

1. Resolve the diagnostic offset unit mismatch for Unicode text and document it consistently across request serialization and prompt rendering.
2. Decide whether the current `FileChunk.start_line` base inconsistency is tolerated by the server contract or should be normalized at the API boundary.
3. Preserve current tuning defaults only when product owners confirm they remain desired; none of the listed caps/ranking details are implied by the public Zeta protocol.
