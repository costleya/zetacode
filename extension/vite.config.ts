import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: [".codex/config.toml", ".codex/s-obvious-dev-plugins/state.json", "AGENTS.md"],
  },
  lint: {
    ignorePatterns: [".codex/config.toml", ".codex/s-obvious-dev-plugins/state.json", "AGENTS.md"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  pack: {
    entry: { extension: "src/extension/activate.ts" },
    outDir: "out",
    // The VSIX excludes node_modules; only VS Code and Node built-ins stay external.
    deps: {
      neverBundle: ["vscode"],
      alwaysBundle: [/^(?!vscode$)/],
    },
    outputOptions: { codeSplitting: false },
  },
  plugins: [
    {
      name: "vscode-test-module",
      // VS Code provides this module in its Extension Host. Let the setup
      // file supply it when running tests in Node instead.
      resolveId(id) {
        if (id === "vscode") return id;
      },
    },
  ],
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // Benchmark artifacts use their own runners; keep the unit suite explicit.
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup-vscode-mock.ts"],
  },
});
