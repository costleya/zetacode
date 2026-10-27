# Bundled Zeta and Qwen runtime

NESweep automatically stages and starts this packaged runtime on Apple Silicon
macOS. The extension uses typed gRPC over a private Unix socket and the fixed model IDs
`zeta-2.1` and `qwen2.5-coder-7b-instruct`. It downloads model weights from
Hugging Face; the weights are not bundled. Install uv before activating NESweep.
Use **Check Local Models** in the extension menu to prepare or retry setup.
Managed startup passes `--socket-path /tmp/nesweep-UID/STORAGE_HASH.sock`, using
the first 16 hexadecimal characters of the resolved storage root's SHA-256 hash.
The parent directory must be owned by the current user with mode `0700`; the
server creates it if absent and sets the socket to `0600`. A persistent `.lock`
file beside the socket holds an exclusive lock until socket cleanup completes.
The helper preserves live sockets and unrelated files, and only removes a stale
socket after acquiring that lock. Managed startup opens no TCP listener.

## Developer checkout launcher

The commands and override flags below are for standalone runtime development.
They do not configure the extension or provide an external backend mode.

The server runs both models directly on Apple Silicon macOS 14 or later with Metal GPU
access, using its own Python environment and Hugging Face model cache. Install [uv](https://docs.astral.sh/uv/getting-started/installation/),
then run from this checkout:

```sh
uv sync --locked --project tools/zeta-server
tools/zeta-server/run.sh --socket-path "/tmp/nesweep-$(id -u)/developer.sock"
```

Runtime Python modules live in `src/`; the launcher runs `src/server.py`.
The extension packages this source directory and the three environment manifests
(`pyproject.toml`, `uv.lock`, and `.python-version`). It stages their nested
paths under its versioned global-storage source directory and launches Python
directly. `run.sh` remains a manual checkout launcher and is not packaged.

`pyproject.toml` and `uv.lock` define the standalone Python 3.13 environment in
`tools/zeta-server/.venv`. uv downloads Python if needed and installs the locked
packages. The launcher also synchronizes that environment automatically. Python
and package setup need network access on the first run.

The defaults are `NexVeridian/zeta-2.1-4bit` for Zeta and
`mlx-community/Qwen2.5-Coder-7B-Instruct-4bit` for Qwen. Model loading downloads
missing files from Hugging Face into its normal cache; later runs reuse them.
Set `HF_HOME` to choose that cache's parent directory. `ZETA_MODEL` and `QWEN_MODEL`
can name alternative compatible repositories or independent local MLX directories.
The matching CLI overrides are `--model PATH_OR_REPO` and `--qwen-model PATH_OR_REPO`.
Both models load eagerly before the server announces readiness or accepts requests,
so the short continuation budget is never spent loading weights.
`run.sh --help` installs dependencies if needed but exits before loading or
downloading any model.

Managed startup supplies the optional pair `--status-file PATH --setup-id UUID`.
The server atomically replaces a private JSON status file during model resolution,
download, and loading, with a five-second heartbeat until both models are ready.
Manual launches may omit both options. Status records identify the setup and model,
and distinguish received network bytes and their recent speed from reconstructed
model-file bytes (which can include resumed data). Hugging Face Xet compression and
deduplication make network totals unpredictable, so network percentage uses Hugging
Face's changing denominator and is explicitly an estimate, capped below 100%.
The subsequent loading stage confirms the download returned successfully. No network
ETA is invented. Reconstruction totals cover the pending files discovered by the download,
and may grow while workers initialize. Cached files require no new transfer.
The normal MLX file selection is preserved; resolved snapshots are then loaded from
their local paths without a second online lookup. Local model directories skip
download resolution. Error status contains only a failure category; detailed errors
remain in the server log.

For a separately managed environment, set `ZETA_PYTHON` to an executable Python
with the locked dependencies installed; this bypasses uv.

The CLI requires `--socket-path ABSOLUTE_PATH`. Socket paths must fit within
103 encoded bytes. The runtime listens only on that private Unix socket.
The canonical schema is `src/proto/completion.proto`. `nesweep.CompletionService`
provides unary `Health` (ready plus both model IDs) and server-streaming `Complete`.
Health becomes ready only after both models load. Complete accepts the model ID,
nonempty prompt, temperature, repetition penalty, token budget, stop strings, and
independent notification opt-ins. Zeta uses temperature 0 and repetition penalty 1;
Qwen uses temperature 0 and repetition penalty 1.1 with a raw
`<|fim_prefix|>...<|fim_suffix|>...<|fim_middle|>` prompt. Unsupported sampling options
or invalid requests fail with gRPC `INVALID_ARGUMENT`. An omitted token budget uses
2048 for Zeta or 192 for Qwen; explicit zero remains zero. Qwen permits up to 512 tokens.
The stream sends opted-in lifecycle events and one final typed result with text,
finish reason, and optional prompt/output token counts. Token text is buffered until
that result. Qwen applies no chat template or automatic special tokens.

Generated Python stubs live beside the runtime modules; TypeScript bindings live in
`src/api/generated/completion.ts` at the repository root. Both are checked in and no
runtime code generation occurs. To regenerate from the canonical schema after
`pnpm install`, run `pnpm generate:grpc`; the Python `codegen` dependency group and
pnpm lock pin the generators. The packaged schema and Python bindings participate
in the managed source hash, so protocol changes stage a fresh runtime.

The target model verifies each proposed source-token block with causal attention.
Only its greedy tokens are committed; rejected tokens are removed from the KV
cache. Weak suffix matches propose at most two tokens. Zeta requests serialize
access to its own model and reuse their common prompt prefix. Equal-strength source matches prefer
the most recent occurrence. Disconnects and the 30-second request deadline are
checked between model calls. Cancellation at these synchronized checkpoints
preserves the consistent prefix; unexpected failures invalidate the cache. A single long GPU call cannot be interrupted mid-kernel.
Prompt prefill projects only the last Llama hidden state to vocabulary logits.
The combined prompt token count and requested `max_tokens` must fit the model's
`max_position_embeddings` (32,768 for these weights; fallback 32,768 if unspecified).
Oversized requests fail before prefill without truncation. `--context-length` can
set a smaller positive context limit for either the server or corpus runner.

MLX retains unused GPU buffers separately from live model weights and the prompt
KV cache. `--cache-limit-mb` sets a reuse target of 256 MiB for these allocator buffers
by default; use a nonnegative integer, with `0` disabling allocator caching. The limit
is applied once before loading either model. A shared allocator coordinator
synchronizes the current request stream and reclaims excess unused buffers when
the last overlapping request completes, including cancellation and errors. It
defers global cache clearing while another decoder is active. It does not limit live weights,
the KV cache, or temporary memory needed during generation. Prefix reuse and the
configured context limit are preserved.

The server defaults `MLX_METAL_RESIDENCY_REFRESH_INTERVAL_MS` to `1000` before
importing MLX. On supported Metal hardware with macOS 15 or later, this renews
residency once per second to reduce idle GPU wake-up latency. After both models
load, it sets one shared wired-memory budget to the smallest of active MLX memory
plus the allocator cache limit, one quarter of system RAM, and one half of Metal's
recommended working set. This leaves the allocator cache and reclaim policy above
in place. Successful setup logs the budget in bytes and refresh interval;
unsupported APIs or platforms, invalid capacities, and configuration failures log
a warning and allow startup to continue.

Set `MLX_METAL_RESIDENCY_REFRESH_INTERVAL_MS=0` to disable refresh and skip this
wired-memory configuration. Explicit inherited values are preserved in the managed
LaunchAgent. These settings apply at startup: an existing managed service must be
stopped and started through setup to load updated source and environment. Reloading
the extension or choosing **Check Local Models** alone keeps a healthy service
running; setup does not automatically replace it.

Clients opt in with `notify_first_token` and `notify_no_edit_impossible`.
After the first verified, committed, non-EOS output token, the helper streams one
`first_token` event. Prefill and draft proposals do not trigger it. The extension
uses it to begin speculative Qwen fallback while retaining Zeta's priority.
Once committed Zeta text cannot become two identical marker boundaries (optionally
followed by Zeta's EOS marker), the helper streams one `no_edit_impossible` event.
Partial markers, decoded Unicode tails, and stop-string prefixes remain conservative.
The extension aborts only the paired Qwen request and prevents a later first-token
event from starting it. The final result still determines fallback eligibility.
Requests without notification opt-ins receive only the final result.

Cancellation and gRPC deadlines reach the decoder's cooperative cancellation checks,
including requests waiting for a decoder lock. Shutdown cancels work before releasing
the socket's lifetime lock. The readiness log reports process-global allocator memory
and per-decoder cache snapshots; prompts are not logged. Non-timing draft statistics,
raw token IDs, and memory counters are available through the standalone decoder
runner rather than the completion wire result. Cache reuse is reported as
`cache.cached_prompt_tokens`; custom `timings` and `verification_seconds` fields
have been replaced by OpenTelemetry spans.
Qwen uses greedy decoding with repetition penalty 1.1 over the previous 20
tokens. Its repetition-history allocation stays bounded to that window and is
initialized from the entire new prompt, independently of cache reuse. Like Zeta,
Qwen retains its KV cache between requests and reuses the longest identical token
prefix, leaving at least one prompt token to compute fresh next-token logits.
It trims divergent cached tokens before prefilling the remaining prompt and reports
the reused count in `cache.cached_prompt_tokens`. Success, stops, and safe cancellation
retain consistent KV state; unexpected failures invalidate it. Idle decoder memory
snapshots include the retained `kv_cache_bytes`.
Qwen builds and submits its next decoding step asynchronously before reading the
current token back to the CPU. Device token arrays preserve the bounded repetition
history while GPU evaluation overlaps graph construction and CPU text decoding.
It schedules only when another output token fits the request budget, drains pending
work before cancellation or return, and trims unused KV inputs when EOS, a stop
string or a callback ends generation. Buffered delivery and greedy token selection
are unchanged.
No raw prompts are logged. The standalone `src/decoder.py --model PATH --corpus JSON
--output JSON` runner writes private results including full outputs and token IDs.
Its corpus takes `cases` containing `id`, `prompt`, `maxTokens` and `stopTokens`.

Latency depends on prefix cache reuse and source overlap. Cold model/prompt work
and newly generated code still cost time; this is not a general subsecond
latency guarantee. Floating-point kernels can choose a different near-tied token
for a multi-token block than for single-token decoding; exact byte-for-byte
parity across every prompt is not guaranteed. Compare complete outputs and
parsed edits, not initial tokens.

On 2026-10-22, warm HTTP replays on this Mac Studio with the same 4-bit weights
used a captured 6,141-token Zeta prompt (206 output tokens) and a 1,830-token
Qwen prompt (16 output tokens). Three-run median elapsed times were:

| Request               | Baseline |                           Optimized |
| --------------------- | -------: | ----------------------------------: |
| Zeta alone            |   678 ms |                              677 ms |
| Zeta overlapping Qwen | 1,226 ms | 933 ms with early Qwen cancellation |
| Qwen alone            |   695 ms |                              694 ms |

Early cancellation reduced Zeta's overlapping wait by 293 ms in this replay.
Qwen alone showed no meaningful speedup in that earlier request-cache experiment;
releasing its request cache reduced retained Qwen KV memory from 112 MiB to zero
(the current prefix-reuse implementation retains that memory). Twelve compared HTTP responses
had identical text, finish reasons, token counts, and usage; HTTP responses do
not expose token IDs. Three additional real no-edit responses containing two
`marker_1` boundaries emitted no cancellation signal; unit tests cover broader
prefix and stop cases.

This is a small warm sample, excluding initial model loading and editor context
collection/rendering. Private measurement artifacts are
`/private/tmp/nesweep-qwen-optimization/baseline.json`, `early-cancel.json`, and
`noedit-smoke.json` in the same directory.

## OpenTelemetry tracing

The server uses a private OpenTelemetry SDK provider with resource namespace
`nesweep` and service name `model-server`. It extracts W3C `traceparent` and
`tracestate` from gRPC metadata to connect each Complete server span to the
extension request. Its generation span includes executor and model-lock waiting;
prefill and decode spans measure actual decoder phases. A `first_token` event
marks the first committed non-EOS token. Token counts, cache reuse, speculative
draft counts, and memory byte counts are safe numeric span attributes. Prompts,
completions, token IDs, hashes, model paths, socket paths, and exception messages
are never added to traces. Exceptions record only their type and an error status.

`OTEL_TRACES_EXPORTER=none` is the default and exports nothing. Set it to `console`
for local JSON span output, or `otlp` for an explicitly configured collector.
OTLP uses HTTP/protobuf and requires `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (the full
trace URL) or `OTEL_EXPORTER_OTLP_ENDPOINT` (the collector base URL); no default
network destination is used. Standard OTLP headers and timeout environment settings
apply. A configured protocol must be `http/protobuf`. Unsupported or invalid
configuration logs a content-free warning and allows completions to continue.
Both exporters use the SDK batch processor; shutdown drains generation workers
before flushing and shutting down the provider. Tracing configuration applies at
process startup. No automatic instrumentation or process-global provider is installed.

### Strict Python type checking

From the repository root, install the locked environments and run the check:

```sh
pnpm install --frozen-lockfile
uv sync --locked --project tools/zeta-server
pnpm run typecheck:python
```

The root `build`, `lint`, and `typecheck` commands all gate on this check. It uses
an exactly pinned Pyright, the same type checker engine used by Pylance, with
`typeCheckingMode: strict` in the shared root `pyrightconfig.json`. In VS Code,
select `tools/zeta-server/.venv/bin/python` as the Python interpreter and open the
repository root so Pylance reads that configuration. Pylance and the pinned CLI
can ship different engine versions; matching strict settings and interpreter
makes the CLI reproducible but does not promise identical diagnostics across
Pylance releases.

The strict scope is all handwritten server modules under `src`; the unittest
suite is verified separately. Generated protobuf Python implementations are
excluded from strict analysis, and protoc emits their message `.pyi` declarations
when `pnpm run generate:grpc` runs. The small service `.pyi` contract follows the
RPC schema. Local MLX-LM stubs describe only the untyped external surfaces used
by this server; keep those contracts aligned with the locked runtime versions.
The environment targets Python 3.13 on Apple Silicon macOS, matching the MLX
runtime.
