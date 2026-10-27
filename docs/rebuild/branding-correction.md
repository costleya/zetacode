# Branding correction after the initial audited snapshot

The initial source snapshot `30226d334f835c3383e75e73eac0e40d8ea5ba1f` and its `source-manifest.sha256` remain immutable historical evidence. They included a replacement N monogram. After installation, the user identified that this did not preserve the project branding from main.

A second shape-level history review corrected the earlier asset assessment. Main commit `46fbc0a0ccafb7f6bb95a6cda9207446bc7cc070` introduces Aaron's folded-ribbon/Z and separately drawn chevron paths. No earlier SR I-beam, broom, bristle, or chevron drawing geometry persists in those SVG inputs. Shared blue/cyan colors, rounded-square backgrounds and the general chevron concept were not sufficient source-history evidence to classify the new drawings as copied shapes. This is an engineering provenance finding, not a legal clearance opinion.

The seven marketplace/status/loading SVG and PNG inputs are restored byte-for-byte from that pinned main commit. The corrected generator still emits `assets/nesweep-icons.ttf` from those inputs, preserving the Chromium font-decoding fix. The old WOFF2 wrapper is not restored. Extension behavior, inference, caching and runtime sources are unchanged.

The current asset hashes are recorded in `branding-assets.sha256`; the earlier source manifest continues to describe the initial snapshot rather than silently changing its historical hashes. The corrected package is saved separately as `artifacts/nesweep-gpl-rebuild-main-icons.vsix`, preserving the original audited VSIX.
