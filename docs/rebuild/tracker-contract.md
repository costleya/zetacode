# Tracker, edit-history, and persistence rebuild contract

**Accepted baseline:** Sweep commit fa52a26 (2026-02-13).  
**Current target:** main at 46fbc0a0ccafb7f6bb95a6cda9207446bc7cc070. The audited tracker files are unchanged between the active checkout at 3de40ca and current main.  
**Purpose:** specify behavior for an independent implementation of the post-baseline tracker/history/persistence features and the Aaron-dependent safeguards present on current main. This is a behavior contract, not a source design, pseudocode, or license conclusion.

## 1. Baseline retained from fa52a26

The accepted baseline already provides:

- In-memory recent-document snapshots, original-content access/reset, edit diff history, bounded user actions, cursor movement and selection tracking.
- Edit events produce diff records and user-action records. Undo and redo are identified as distinct actions.
- Recent-file context excludes the requested current URI and returns newest visits first.
- Public tracker methods used by the extension/provider include construction, trackFileVisit, trackChange, trackCursorMovement, trackSelectionChange, getRecentContextFiles, getEditDiffHistory, getUserActions, getOriginalContent, resetOriginalContent, and dispose.

Preserve these public behaviors and data records. The contract below covers subsequent requirements; it does not require replacing the baseline diff formatter or the full tracker.

## 2. Public interface and ownership

Keep an extension-facing tracker service that supports these operations:

- Construct with an optional VS Code ExtensionContext. A caller without a context still gets in-memory tracking, but it must not attempt workspace-state reads or writes. A caller with a context begins restoration asynchronously.
- Register the active text document or no active document. Active-document state is used when selecting edit-history records.
- Record document visits, document-change events, cursor/selection events, and deleted-file/folder events.
- Retrieve recent context snapshots, selected edit records, and user actions in the shapes expected by current callers:
  - Edit record: filepath, diff, timestamp.
  - Context file: filepath, content, optional mtime, optional cursorLine.
  - User action: action_type, line_number, byte offset, file_path, timestamp.
- Expose an awaited flush operation for lifecycle shutdown and a deletion operation for filesystem watcher events.
- Keep the exported document eligibility and workspace-membership checks behaviorally equivalent. These are ordinary platform filters; an independent design may choose a different representation.

The current extension wiring is part of the behavior contract: change events are recorded for the active document; active editor changes update active-file state and track the visit; active-document selection events record selections/cursor positions; a filesystem watcher forwards deletions; deactivation awaits a final flush.

## 3. Document eligibility and context privacy

Only file, untitled, and vscode-remote document schemes are eligible for tracker events. Other virtual documents—such as output, SCM comparison, settings, and history views—must not contribute recent-file snapshots, edit records, user actions, or active-file changes.

Recent-file prompt context is limited to documents inside a VS Code workspace. A standalone file outside a workspace must not become recent context or expose an absolute path through the context list. The explicitly requested current URI is excluded from the result. Returned entries are ordered from most recently visited to least recently visited and capped by the caller's requested maximum.

Visit behavior has these requirements:

- Initialize original content only when the document has no prior original-content entry; keep the live document contents current for future change diffs.
- Record a snapshot only after workspace membership is established and the visit has not been invalidated by a deletion or newer lifecycle event.
- Include the latest available modification time in seconds when the filesystem provides it.
- Untitled and dirty documents may still be tracked when a stat call fails. A clean saved document whose stat fails is not treated as a successful visit.
- Keep at most ten recent snapshots, retaining the most recently visited.

## 4. Edit history and coalescing

### Per-file retention

Replace the baseline's single cross-file FIFO behavior with file-associated history:

- Retain edit history separately by filepath so edits in one file do not immediately evict every edit from another recently used file.
- Retain at most 15 records per file in memory and at most ten file buckets. When a file bucket must be evicted, prefer keeping files with the most recent edit activity.
- A newly captured edit record includes filepath, formatted diff, and event timestamp.
- No-op content changes must not create edit records.

### Typing-burst collapse

A burst may be collapsed when it meets all of these conditions: it concerns the same filepath; its edits are no more than 60 seconds apart; and the new-side hunk ranges overlap or are separated by at most one line. A valid incoming record supersedes matching older records in that burst. Records on different paths, beyond the time boundary, with unparseable hunk headers, or separated by a larger line gap remain distinct.

Range parsing must tolerate unified-diff hunk headers with omitted counts (the omitted count means one line), multiple hunks in one diff, and zero-length new-side ranges used by deletions. For a zero-count range, its effective endpoint is the hunk's start line. Preserve inclusive range behavior and the one-line adjacency boundary.

The implementation may use a different parser, range model, or grouping structure. It must preserve the observable cases above, including exactly-at-60-seconds being within the merge window and a two-line gap remaining separate.

### Prompt selection

getEditDiffHistory retains its no-argument public signature. It returns a single list of records ordered newest-first, with a maximum count controlled by sweep.maxEditHistory (default 15, minimum 1).

Selection must protect active-file history while also representing recent work in other files. The current allocation reserves about 20% as an active-file floor, gives about 40% to up to sweep.maxContextFiles other recently edited files (default 5), and uses remaining capacity for active-file activity. If a selected bucket has too little history to use its allocation, available slots may be filled from already included other buckets. Other buckets are prioritized by their latest record timestamp. No output may exceed the total budget; empty history produces an empty list; zero allowed context files means no other-file buckets.

These are user-visible allocation requirements, not a required data structure or step-by-step algorithm. A replacement may use a different fair-selection policy if it preserves the active-file floor, the other-file cap, recency, and total limit. The tracker controls record count; the provider separately applies sweep.maxRecentChangesChars (default 12,000; zero omits rendered recent history), so do not conflate the record budget with the prompt-character budget.

## 5. Persistence and compatibility

With an ExtensionContext, tracker state survives window reloads. Without a context, the tracker remains session-only.

### Save behavior

- Mark state dirty when tracked state changes and debounce persistence until five minutes of inactivity.
- A final flush on deactivation must await startup restoration, cancel a pending timer, and persist dirty state before teardown.
- Flush must not overwrite restored state before asynchronous startup loading completes.
- Persist best-effort: a workspace-state write failure must not break document tracking or shutdown.
- Keep recent-file content out of workspace-state storage. Persist URI and visit metadata, including mtime and cursor line where available; reload current file content from the workspace when restoring.
- Persist the user-action and cursor-position histories with edit history and recent-file metadata.
- Bound persisted edit history to five most recent records per file and retain no more than ten file buckets.

### Stored-state compatibility

Continue to read the current version-2 entry under sweep.tracker.v2. Its logical fields are:

- version and save timestamp;
- recent per-file edit buckets, each containing filepath, last-edit timestamp, and records;
- user-action records;
- URI-keyed cursor snapshots with line and timestamp;
- recent-file metadata containing URI, visit timestamp, optional mtime, and optional cursor line.

Also read the accepted legacy version-1 entry under sweep.tracker.v1, whose edit history is a flat record list. Convert valid records into per-file history, preserve chronology, and apply current merge/retention behavior. Ignore unsupported versions without failing tracker initialization. The legacy-v1 migration skips records lacking a string filepath/diff or numeric timestamp; URI parsing failures are skipped. Current v2 loading validates bucket structure and filepath but does not comprehensively validate every nested record or cursor tuple, so stronger malformed-state tolerance is a design hardening choice rather than a proven compatibility guarantee. After legacy recognition, schedule/preserve a v2 save and attempt to remove the legacy key so subsequent launches do not repeatedly import it. Maintain these keys/shapes or provide a lossless migration from them; do not silently discard existing user state during an independent rewrite.

### Restore current state safely

- Restore at most the newest 50 user actions; restore saved cursor-position entries and associate persisted cursor lines with restored recent-file snapshots.
- Restore edit records only for files that remain valid. When a target is missing, remove its saved snapshot/history/actions; preserve an open dirty or untitled document despite absent on-disk content.
- Recent-file snapshots are rebuilt from current disk bytes (or the current dirty document), not stale saved text. Retain the stored visit timestamp and cursor line.
- On transient filesystem/provider/permission errors, do not save file contents. Retain only metadata necessary to retry the read on a future load; do not include unavailable content in prompt context.
- Restore saved remote-workspace files using their saved URI when available. A path alone cannot identify a remote filesystem; do not validate uncertain remote paths as local files.
- A new live visit/edit, or a deletion, wins over an older asynchronous restore. A pending restore must not resurrect a deleted file, replace newer content/history, or erase a newer successful visit.
- A delayed failed startup read must not erase a newer live snapshot or edits.
- Invalid saved URI strings and malformed legacy-v1 edit records are skipped. Full validation of malformed nested v2 records and cursor tuples is not guaranteed by the current loader.

The internal version-counter, pending-operation registry, or ordering mechanism used to implement these guarantees is an independent design choice.

## 6. Deleted-file and folder lifecycle

The filesystem deletion watcher forwards a deleted URI to the tracker. Deletion cleanup must:

- Remove snapshots, unavailable-file metadata, original/current document contents, cursor state, selection/change summaries, edit-history buckets, and user actions for the deleted file.
- For a deleted folder, remove descendants using path-segment boundaries; a similarly named sibling must survive (for example, deleting /workspace/tmp must not remove /workspace/tmp-kept).
- Invalidate pending visit/restore operations so that an older asynchronous stat/read cannot restore deleted context.
- Schedule persistence when tracked state was removed or pending restore state was invalidated.

## 7. User-action, cursor, and Aaron-dependent behavior

Retain the existing user-action contract: cursor positions and text edits are associated with normalized file paths and UTF-8 byte offsets. getUserActions may receive the current cursor; if the stored final action does not already represent that exact cursor location, return a result that includes the current cursor action without mutating stored history. Keep the configured history cap of 50 actions.

The current branch also has a newline-insertion eligibility signal:

- A candidate is recorded only for an active document change with no explicit undo/redo reason, exactly one content change, zero replaced length, an empty original range, and inserted text consisting of a line break followed only by at most 200 spaces/tabs.
- The resulting cursor must be on a whitespace-only line.
- Eligibility is tied to the same document URI, document version, and exact cursor line/character; it expires after ten seconds.
- Replacing a selection with newline, a multi-change event, another ordinary edit, moving to a different cursor position, switching documents, or deleting the document invalidates the candidate. A metadata-only event with no content changes preserves it.
- A query succeeds only if all the identity/version/position/time conditions still hold and the current line remains whitespace-only.

Observed limitation: the current production path does not call hasRecentNewlineInsertion; this capability is exercised by tracker tests but is not currently wired into the inline-edit provider's continuation fallback. Decide explicitly whether the next implementation must preserve this currently dormant API or omit it. Do not couple it to continuation fallback without confirming the intended product behavior.

The request-generation path has independent freshness gates for continuation requests (latest request, current session, cancellation/staleness, enabled state). Those gates are outside this tracker contract and must remain owned by the provider/API layer.

## 8. Independent design choices and explicit open decisions

The replacement may change internal class layout, collection types, serialization implementation, diff-range representation, migration sequencing, async task coordination, and allocation mechanics. It may not change the observable API data shapes or the behavior/boundaries above without a separate product decision.

Open decision for the next owner: should the currently test-only newline eligibility method remain in the rebuilt tracker, or should it be removed as dormant behavior? The original tests encode exact boundary expectations, but there is no current production caller.

## Evidence in current main

- Public tracker symbols and spans: src/telemetry/document-tracker.ts (DocumentTracker constructor, trackFileVisit, trackChange, setActiveFile, forgetFile, getRecentContextFiles, getEditDiffHistory, getUserActions, flush, load).
- Coalescing API: src/telemetry/edit-merger.ts (parseNewSideRanges, parseNewSideRange, rangesOverlap, shouldCoalesce).
- Integration: src/extension/activate.ts wires changes, visits, selection events, deletion events, and deactivate flush; src/editor/inline-edit-provider.ts consumes recent file/history/action data.
- Existing contract edge cases are visible in test/edit-merger.test.ts, test/document-tracker-lifecycle.test.ts, and test/document-tracker-continuation.test.ts; tests were inspected, not run.
