# Installed NESweep provenance and runtime reference

Read-only inspection of the installed VS Code extension and its managed runtime on 2026-10-27. No model weights or private documents were opened or copied; no model request was made and no server was started.

## Installed package and source relationship

- VS Code records the extension as `s-obvious.nesweep@1.2.7`, source `vsix`, pinned, installed at timestamp `1793084391099` (`extensions.json`). The installed path is `/Users/costleya/.vscode/extensions/s-obvious.nesweep-1.2.7`.
- The local VSIX `/tmp/nesweep-1.2.7-current.vsix` has a 2026-10-27 15:59 timestamp. Its `extension/out/extension.mjs`, `decoder.py`, `continuation_decoder.py`, icon font and primary icon have byte-identical SHA-256 hashes to the installed files. The VSIX and installed `package.json` also have the same canonical JSON after removing VS Code's injected `__metadata`. This establishes that the installed payload is byte-for-byte consistent with that local VSIX for those files; VS Code's install record itself only says `source=vsix`, so it does not identify the VSIX path.
- Installed `package.json` reports version `1.2.7`, publisher `s-obvious`, `main=./out/extension.mjs`, `onStartupFinished`, engine `^1.142.0`, and repository `https://github.com/sr-tream/vscode-nes`. `.vsixmanifest` repeats the source URL and API proposal declarations but has no Git revision/build ID.
- No source map or build-commit marker is shipped. The available main checkout's `out/extension.mjs` is 4,053,438 bytes with SHA-256 `7e78d6c43e002034438edf7259c721925b8975bfbdfba1442e3fb9424a88efd7` (timestamp Oct 24); installed bundle is 4,795,545 bytes with SHA-256 `2a7ebcffde057254f84001000c1d10fd61886dad56d7a63132b84092a3ea7815` (timestamp Oct 27). They differ, and the main checkout artifact is stale relative to the install time. `/tmp/nesweep-pnpm-install.log` only records dependency installation and provides no source revision. Thus exact TypeScript source commit for the installed bundle remains unresolved; version equality is not used as proof.
- Installed helper sources `decoder.py` and `continuation_decoder.py` are byte-identical to current main (`489d2996…726ed` and `4034c9c5…f271c`). All shipped NESweep icon assets are also byte-identical to current main, including the Oct 27 icon refresh. The helper tree fingerprint produced by `ManagedLocalServer.stage` for the installed extension is `95d6adefeb7f8602580c3af8b9c0689a2b95de1ad4b19a27c9c87e0f7143044d`.
- The JS bundle contains the generated `CompletionService` / `CompletionRequest` client, `/nesweep.CompletionService/Complete`, first-token/no-edit lifecycle events, Unix-socket transport, managed-server LaunchAgent code, and the fixed Qwen model ID. Its extension package includes the current gRPC Python runtime source and assets. This confirms those shipped behaviors, but the absent map/commit marker prevents exact TS revision attribution.

## Shipped code versus the already-running model service

The installed extension package contains Qwen persistent KV-prefix reuse and asynchronous decode: its `continuation_decoder.py` has cache trimming/reuse and `_async_eval_array` (`mx.async_eval`), and its source hash exactly matches current main. Its decoder source also includes retained Zeta prompt-cache behavior.

The already-registered LaunchAgent is a different runtime revision. Read-only `launchctl print gui/501/com.nesweep.local-models` reported `state = running`, PID `1612`. Its arguments point to:

`/Users/costleya/Library/Application Support/Code/User/globalStorage/s-obvious.nesweep/local-models/sources/fae6d49d645c9f8877664983102a578ca0b80a0167edbc6a3401980b1ae8ac74/src/server.py`

That staged source tree differs from the installed helper tree. It has the gRPC server/proto, Unix socket service, first-token and no-edit events, so the live service is on the managed gRPC path. Its `continuation_decoder.py` resets to a fresh cache for every FIM request, reports `cached_prompt_tokens=0`, and has no `mx.async_eval` path. Therefore the installed extension package has the Qwen KV/async features, but the current live managed server does not. `ManagedLocalServer.provision` skips provisioning when it finds the existing server healthy, which explains how the extension can update without replacing the service.

The socket path is `/tmp/nesweep-501/7acce64699bd9499.sock`; the socket exists with mode `0600`. I did not call Health or Completion RPCs, inspect logs/status contents, or verify that the running server has loaded both weights.

## Available model/runtime paths for future serialized measurements

- Managed storage root: `/Users/costleya/Library/Application Support/Code/User/globalStorage/s-obvious.nesweep/local-models`.
- LaunchAgent environment points `HF_HOME` to `.../local-models/huggingface`, `UV_CACHE_DIR` to `.../local-models/uv-cache`, and `UV_PYTHON_INSTALL_DIR` to `.../local-models/python`. The managed environment has Python 3.13 (`uv 0.12.21`), `mlx-lm 0.32.2`, and `grpcio 1.84.1`. `MLX_METAL_RESIDENCY_REFRESH_INTERVAL_MS` is absent from the displayed LaunchAgent environment; the helper's default is the value to record/verify for any benchmark.
- Cached snapshot directories exist for `NexVeridian/zeta-2.1-4bit` at snapshot `618d01cb3dd561b01437a3ae2f23555963e1884a` and `mlx-community/Qwen2.5-Coder-7B-Instruct-4bit` at snapshot `019cc73c45c770444708a6dd8690c66243cc5c80`. Each contains a `model.safetensors` link and tokenizer/config metadata. These are available cache snapshots; without model RPC or process inspection they are not asserted to be the weights currently resident in memory. No model files were copied into the archive.
- The active LaunchAgent uses an absolute Python path and `PATH=/usr/bin:/bin:/usr/sbin:/sbin`; this is separate from `sweep.serverUrl` and `sweep.modelName`, which are persisted in user settings but are not used by the current extension implementation.
- For a fair current-main comparison, the next authorized run must serialize benchmarks and ensure the managed server is using the installed/current helper fingerprint rather than the older `fae6…` source. Preserve the current cached snapshots and record the actual serving helper hash, model snapshot IDs, cache state, socket, and whether the service was warm or cold.

## Immutable archive

A read-only tar archive of only the installed extension directory is at `/private/tmp/nes-rebuild-installed-reference/s-obvious.nesweep-1.2.7-installed.tar.gz`. SHA-256: `94722562443a5c0956302eb883287d349962b014f329070ac96009b464ad03cf`. The archive directory is mode `0555`; archive and sidecars are read-only. The archive contains VS Code extension files only, not global storage, model weights, Python environments, sockets, runtime logs, or user documents.

## Remaining provenance uncertainty / next owner

A rebuild/parity owner should retain the archived installed payload and record a Git commit or source tree hash when producing the candidate VSIX. The installed JS bundle's source commit cannot be proven from its version, VSIX repository URL, or matching icons/helper subset. Before performance comparison, the runtime owner should cold-reprovision or otherwise pin the running service to the candidate helper fingerprint under explicit authorization; otherwise measurements would compare the new extension client to the older live decoder.
