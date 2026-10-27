# NESweep

Local next-edit suggestions and fill-in-the-middle completions for Visual Studio Code. The extension uses Zeta 2.1 and Qwen with a managed local model service on Apple Silicon.

## Development

Use Node.js 24 and the pnpm version declared in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test --run
pnpm build
pnpm exec vsce package --no-dependencies
```

Launch the extension with the included VS Code development configuration. The model service requires `uv`; see [runtime setup](tools/zeta-server/README.md).

## Source reconstruction

This branch starts from Sweep commit `fa52a26` and integrates independently reconstructed middle-fork features plus Aaron Costley's own additions. The reconstruction and its functional and performance validation are still in progress; see [the progress record](docs/rebuild-progress.md). The existing main branch and installed extension remain the comparison references.

The project targets GPL-3.0-or-later. See [LICENSE](LICENSE) and the provenance records under `docs/rebuild/`. Model weights and third-party packages retain their separate licenses.
