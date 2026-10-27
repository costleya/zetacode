# NES editor rebuild: behavior contract

## Purpose and evidence

This document specifies observable behavior for rebuilding the editor additions around accepted Sweep source from `fa52a26`. It describes behavior and interoperability requirements only. It does not prescribe source layout or reproduce upstream implementation, pseudocode, algorithms, or comments.

Reference checked: local `main` at `46fbc0a`; editor behavior is the same as checkout `3de40ca` (the newer main commit only updates ribbon assets). Existing provider, jump-preview, and theme behavior at `fa52a26` remains the accepted foundation. The additions below come from later SR_team and Nishimura-Katsuo contributions, plus Aaron-authored behavior that integrates with or protects those features. Git history and current tests establish expected behavior; authorship is not a legal conclusion.

A future implementation can choose its own modules, state representation, and methods. It should satisfy the behaviors below while preserving baseline behavior and the explicitly identified local FIM, native-highlighting, and async-render protections.

## Data and host contracts

A completion presented to the editor represents a replacement of a half-open range in the current document with text. Its identity must survive presentation and acceptance so that an accepted item can update any remaining suggestions. An optional predicted cursor location is an offset within the inserted completion text, measured in JavaScript UTF-16 code units.

The provider integrates with VS Code's stable inline-completion API by default. It may use the `inlineCompletionsAdditions` proposed API only when the user opts into Copilot-style next-edit presentation and the host permits the proposal. The proposal adds inline-edit display/menu metadata, an optional display location, correlation identity, and forward-stability behavior. Provider registration metadata is optional and must not prevent stable provider registration when VS Code rejects specifically that proposal.

The renderer may return decorations asynchronously. The jump-preview manager must expose a completion outcome for a render lifecycle (handoff, cancellation/skip, or error) and deliver that outcome at most once for the current lifecycle.

## Display routing

Keep the existing decision contract for each candidate:

- **Inline:** the edit is on the cursor line and can safely be represented by ordinary ghost text. A same-line insertion after the cursor remains inline. A same-line replacement remains inline when the new text extends the replaced text.
- **Jump:** the edit is outside the cursor's two-row padded vicinity; begins before the cursor; starts on a different later line; replaces across multiple lines beginning at the cursor; or replaces same-line text at the cursor with text that does not extend what it replaces. A jump must be visible as a preview or, when proposed presentation is enabled and usable, as a proposed inline edit.
- **Suppress:** a multiline edit anchored at the cursor on the nearby single-newline boundary is suppressed in the tested case. Suppressed candidates must not replace an already valid item with an invalid one.

The classification is per candidate and must consider both its edit range and replacement text. Preserve selected-completion compatibility: if VS Code supplies a selected completion range/text, an inline edit is eligible only when its edit range exactly matches the selected range and its replacement begins with the selected text. Otherwise discard that candidate.

Do not force an item that starts before the cursor into ordinary inline ghost text. In default mode it must use the existing jump-preview fallback. In proposed mode it may use the host's inline-edit presentation support.

## Proposed next-edit presentation

This mode is opt-in and off by default. When enabled and available, the extension can mark eligible distant edits as inline edits, expose the inline-edit menu, and associate an edit with a display range/location and stable correlation identifier. Preserve the item’s actual replacement range independently of any visual display location.

When the proposed API is denied specifically because `inlineCompletionsAdditions` is unavailable, retry provider registration through the stable API with the same selector/provider. Propagate unrelated registration errors and stable-registration errors. Do not silently retry on a different API denial or a generic malformed-metadata error. If registration succeeds only through the stable API, ordinary ghost text and custom jump previews still work; the proposed presentation fields may be unavailable.

When proposed presentation is off or unavailable, preserve baseline jump-preview behavior. Do not make the opt-in proposal a dependency for the extension to activate or for normal inline suggestions to appear.

## Multiple independent edits and acceptance queue

When Copilot-style presentation is enabled, a model result containing separated edits may be shown as a sequence of smaller suggestions so unchanged text between edits is not included in each visible suggestion. Accepting one item advances to the next valid item. Later edit ranges must remain aligned after earlier accepted replacements change document length. Each queued item is revalidated and normalized against the live document before presentation; invalid, no-op, or suppressed items are skipped. If the next item routes to a jump, show the appropriate jump/proposed presentation rather than treating it as an inline item.

Splitting is only required for bounded inputs: the current supported envelope is at most 128 old lines and 128 new lines. If an input exceeds that envelope, contains a model cursor target, or cannot be separated without unsafe newline/deletion behavior, retain the original candidate as one item. Do not turn omitted trailing source context into a deletion. A final insertion after a preceding edit may be presented as its own item while preserving the newline needed to apply it. Insertion/deletion combinations that cannot be safely separated remain combined.

This is a result contract, not an instruction to use the original LCS implementation. Any independent bounded comparison/segmentation design is acceptable if it meets the cases above and has predictable bounded work. The non-split fallback is preferable to destructive or misaligned edits.

## Cursor target and acceptance

The Zeta response path may include a cursor marker inside generated replacement text. Remove all recognized marker text from what the user sees and inserts; when more than one marker occurs, only the first establishes the predicted cursor location. Carry the resulting optional UTF-16 offset with the completion through normalization and acceptance.

For ordinary inline completion, a completion with a predicted cursor location must place the editor's final-cursor tabstop at that offset. For proposed inline edits, use plain replacement text, then restore the predicted cursor after acceptance; proposed/snippet acceptance can otherwise alter the deletion range. The cursor target belongs to the completion’s replacement text, not the document or prompt. If normalization removes text before it, adjust the offset; if normalization removes the target itself, discard it. Clamp restored positions to a valid post-edit document position.

Acceptance of queued edits must preserve this cursor behavior without corrupting the remaining queue. Preserve deletion candidates whose replacement text is empty when their edit range is nonempty.

## Prefix typing and in-flight reuse

For a pure insertion suggestion, preserve the displayed ghost text while the user types forward on the same document and line, provided the newly typed text is a prefix of that displayed suggestion. Do not keep it for a replacement edit, a different file/line, backward movement, or typed content that does not match the displayed prefix.

A follow-up request can reuse an active request only when it is for the same document, the earlier request is still live, and the inserted delta consists solely of identifier characters (`A–Z`, `a–z`, `0–9`, underscore). Punctuation and whitespace start a fresh request because they commonly change the syntactic continuation. If the earlier response can extend the text already typed, present only the still-untyped remainder at the current cursor and keep all remaining ranges correct. If it cannot, issue or retain a fresh current request rather than showing a mismatched stale suggestion.

Cancel superseded or disposed work. Before presenting any result, verify that the document identity, version/content, and cursor snapshot still match the request’s intended context. A late result must never overwrite a newer suggestion.

## Proposed jump navigation

When the user chooses a distant proposed inline edit, the first Tab/click may only navigate to its target; it may not accept the edit or invoke the provider. Keep the pending suggestion visible during that navigation. Recognize arrival at the target line and the immediately preceding visual-anchor line, but only for the same document/version. Schedule one next-edit refresh after arrival, then consume the watcher so selection events cannot schedule duplicates. Before the refresh, verify that the same document/version and landing line are still active. If the user moves elsewhere, edits the document, or the watcher becomes stale, drop the pending refresh.

If proposed presentation is unavailable, the existing jump preview and explicit accept/dismiss commands remain usable. Preview acceptance applies the selected edit, moves/reveals the cursor at the predicted target when present, clears obsolete preview state, and continues any accepted suggestion queue safely.

## Context-exit refresh

Keep the existing option to request another completion after the cursor leaves the model’s editable window. It is disabled by default. When enabled, crossing the established distance threshold schedules a debounced refresh; returning inside the window before the delay expires cancels that refresh. It triggers at most once per remembered window. Document switches or edits invalidate the stored window and establish a new baseline only when the option remains enabled.

Current defaults are a 1,500 ms debounce, 350 editable tokens, and 150 context tokens for Zeta. Configuration may change those values. Keep the refresh tied to the actual active document and current selection rather than editor-object identity, since VS Code may supply a different `TextEditor` instance for a real selection event.

## FIM and suffix-preservation behavior to keep

Insertion requests can display a fast FIM result before a slower Zeta result completes. Keep the first valid intermediate result visible, and publish a later Zeta upgrade only when it is meaningful, belongs to the same live request/session, and the FIM item was actually shown. A rejected, replaced, cancelled, stale, or ended item must not be upgraded. Continue to use session lifecycle callbacks to establish show/reject/end state and avoid duplicate upgrades.

FIM continuations often fill a missing middle before existing same-line text. Preserve the completion literally when trimming a matching suffix could remove a delimiter needed by the inserted expression; retain the current newline-continuation handling. Preserve the local whitespace handling that allows overlap checking past spaces on a blank cursor line. Prefix normalization must retain the existing replacement tail, and a genuine deletion must not be mistaken for a no-op merely because its replacement is empty.

## Native highlighting and asynchronous preview safety to keep

Use VS Code's native full syntax-highlighting tokens when the API is available and returns complete, valid token lengths/colors. If the proposal is unavailable, the call fails, or token data is invalid/incomplete, fall back to Shiki highlighting. Keep native token styles, editor theme/font metrics, and SVG preview rendering coherent across theme changes. Keep Shiki lazy-loaded; normal activation should not eagerly load its language/theme bundle.

Jump-preview decoration rendering can race with newer edits, clears, disposal, active-editor changes, document-version changes, and theme refreshes. Only the newest render for the still-current editor/document may apply. An old success or failure must not finish the current render lifecycle or call its callback early. Resolve or fail the lifecycle exactly once when the current render hands off its decorations, is skipped/cancelled, or errors. Multiline rendering must be awaited before applying its decoration. Theme refresh re-renders the pending preview and supersedes older work.

## Performance and safety expectations

- Keep ordinary request debounce near the existing 50 ms behavior and preserve cancellation responsiveness.
- Keep edit segmentation bounded to 128 lines on each side; larger or ambiguous cases fall back to one edit.
- Context chunking currently caps a visible/recent buffer at 60 lines. Avoid unbounded context expansion during a cursor move.
- Identifier-only in-flight reuse should avoid needless model requests while not delaying a fresh request at punctuation/whitespace boundaries.
- Async preview work should not block the VS Code UI thread, should not paint stale decorations, and should not retain large token/model objects after disposal or theme invalidation.
- Prefer preserving correct single edits over aggressive splitting, stale display, or destructive interpretation of truncated output.

## Independence and verification targets

The rebuild may choose any independent implementation for edit segmentation, suggestion state, queue management, selection compatibility, cursor restoration, and preview scheduling. It should not use retained SR/Nishimura source, comments, or algorithm structure as a template. Use accepted source from `fa52a26` for the Sweep baseline and this contract plus the current tests as behavioral acceptance criteria.

Key observable scenarios to retain include: safe same-line ghost text; a before-cursor edit falling back to jump preview by default; proposed rendering of that edit when opted in; stable API registration when the specific proposal is denied; rejection of mismatched selected-completion edits; successive disjoint edits accepted at correct positions; safe final insertion and truncated-tail cases; preservation of a FIM completion before a live Zeta upgrade; cursor placement after a plain-text proposed edit; one delayed refresh after context exit; a proposed jump that navigates without hiding its item; and no stale decoration applied after clear, replacement, document edit/version change, theme refresh, or disposal.
