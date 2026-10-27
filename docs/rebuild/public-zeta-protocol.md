# Public Zeta 2.1 V0318 prompt protocol research

Research date: 2026-10-27. Scope: public first-party Zed model card and upstream Zed source plus NexVeridian quantized model card. No sr-tream repo inspected.

## Findings

- Official Zeta 2.1 model card: https://huggingface.co/zed-industries/zeta-2.1
  - Fine-tuned from ByteDance-Seed/Seed-Coder-8B-Base; model version 0323-multi-region-filtered-r3.
  - Calls format SPM (suffix-prefix-middle), with numbered multi-region edit markers.
  - Prompt sequence: `<[fim-suffix]>` + suffix text; `<[fim-prefix]><filename>` related-file/history/target-file sections; target file prefix + numbered markers and cursor token; final `<[fim-middle]>`.
  - Expected response is marker-span content, e.g. `<|marker_1|>replacement<|marker_2|>`.
  - First-party examples: https://huggingface.co/zed-industries/zeta-2.1/blob/main/sample.prompt and https://huggingface.co/zed-industries/zeta-2.1/blob/main/sample.output
- NexVeridian card: https://huggingface.co/NexVeridian/zeta-2.1-4bit says MLX-converted from zed-industries/zeta-2.1 using mlx-lm 0.32.0 (current card reports 8B params, 4-bit, 4.64 GB).
- Upstream Zed source aliases `Zeta2.1` to `V0318SeedMultiRegions`: https://github.com/zed-industries/zed/blob/main/crates/zeta_prompt/src/zeta_prompt.rs
  - V0318 visible special strings include `<[fim-suffix]>`, `<[fim-prefix]>`, `<[fim-middle]>`, `<filename>`, `<|user_cursor|>`, `<|marker_N|>`.
  - Stop token is exactly `<[end▁of▁sentence]>`, with U+2581 LOWER ONE EIGHTH BLOCK in place of spaces. Configure as a generation stop; the model card prompt ends at `<[fim-middle]>`.
  - `token_limits_for_format(V0318)` reports editable=350 tokens and context=150 tokens in current upstream main. These numbers are source implementation details, not a model-card guarantee.
- Upstream marker implementation: https://github.com/zed-industries/zed/blob/main/crates/zeta_prompt/src/multi_region.rs
  - V0318 boundary offsets start at 0/end at editable length; internal split heuristic prefers good block starts after blank lines with >=6 lines accumulated and hard-splits after >=16 lines.
  - Prompt boundaries are labeled in sequence as 1-based `<|marker_1|>`, `<|marker_2|>`, etc. The integer is a boundary ordinal (source subtracts 1 to index offsets), not a source line number; boundaries are not sparse by definition.
  - Output's first and final markers select the replaced span; bytes before/after stay unchanged. Interior tags can be stripped/handled best-effort; missing intermediate tags are warned about, not fatal.
  - One tag only is rejected (“expected at least two”); same first/last ID yields no-op in the shared application helper. Thus a lone opening marker is not public V0318 parser compatibility.

## Implementation-neutral layout

```text
<[fim-suffix]>
AFTER_EDITABLE
<[fim-prefix]><filename>related.py
RELATED_CONTEXT

<filename>edit_history
DIFF_HISTORY

<filename>target.py
BEFORE_EDITABLE
<|marker_1|>
OLD_BLOCK_A
<|marker_2|>OLD_BLOCK_B
<|marker_3|>
AFTER_EDITABLE
<[fim-middle]>
```

Example completion replacing boundaries 2..3: `<|marker_2|>NEW_TEXT<|marker_3|>`.

## Evidence/caveat

HF model card and its samples are the direct public spec. Zed current `main` source confirms implementation details and was checked 2026-10-27. HF `main` is mutable; pin commit hashes when preserving a spec snapshot. I found no first-party basis for accepting a lone marker.
