# NESweep

Local next-edit suggestions and fill-in-the-middle completions for Visual Studio Code. The extension uses Zeta 2.1 and Qwen with a managed local model service on Apple Silicon.

## Native inline edits

NESweep requires a VS Code version with native inline edit support. If your version requires proposed API access for this capability, use VS Code Insiders and start it with `--enable-proposed-api=s-obvious.nesweep`. See [Using Proposed API](https://code.visualstudio.com/api/advanced-topics/using-proposed-api) for setup options. If the API becomes available without proposed access, no flag is needed.

## Development

Use Node.js 24 and the pnpm version declared in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test --run
pnpm build
pnpm package
```

Launch the extension with the included VS Code development configuration. The model service requires Node.js and pnpm; see [runtime setup](server/README.md).

## Acknowledgments

NESweep builds on [vscode-nes by Sweep AI and its contributors](https://github.com/sweepai/vscode-nes), with further development by Aaron Costley. It uses [Zeta 2.1, developed by Zed Industries](https://huggingface.co/zed-industries/zeta-2.1), for next-edit prediction.

[SR_Team's vscode-nes fork](https://github.com/sr-tream/vscode-nes) inspired Aaron to develop NESweep. This project was rebuilt from Sweep AI's original repository without incorporating SR_Team's changes or Git history.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md). Model weights and third-party packages retain their separate licenses.
