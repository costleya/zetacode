import * as path from "node:path";
import * as vscode from "vscode";

export interface MessageTransform {
  pattern: string;
  replacement: string;
}
const exclusions = [
  "**/.env*",
  "**/*.pem",
  "**/*.key",
  "**/*.cert",
  "**/*.crt",
  "**/.dev.vars",
  "**/secrets.yml",
];
const transforms: Record<string, string> = {
  "^(.*?) is a magic number;?\\s*consider replacing it with a named constant\\.?$":
    "replace $1 with a named constant",
  "^Included header (\\S+) is not used directly\\.?$": "remove unused #include of $1",
  "^Variable ['\"`]([^'\"`]+)['\"`] is uninitialized when used here\\.?$":
    "initialise '$1' before use",
  "^Implicit conversion loses integer precision: ['\"`]([^'\"`]+)['\"`] to ['\"`]([^'\"`]+)['\"`]\\.?$":
    "narrow $1 to $2 explicitly with a cast",
};
export class SweepConfig {
  private get values() {
    return vscode.workspace.getConfiguration("sweep");
  }
  private number(key: string, fallback: number, min: number) {
    const value = this.values.get<number>(key, fallback);
    return Number.isFinite(value) ? Math.max(min, Math.floor(value)) : fallback;
  }
  get enabled() {
    return this.values.get("enabled", true);
  }
  get maxContextFiles() {
    return this.number("maxContextFiles", 5, 0);
  }
  get outlineSymbols() {
    return this.number("outlineSymbols", 0, 0);
  }
  get maxEditHistory() {
    return this.number("maxEditHistory", 15, 1);
  }
  get maxRecentChangesChars() {
    return this.number("maxRecentChangesChars", 12000, 0);
  }
  get includeClipboardContext() {
    return this.values.get("includeClipboardContext", true);
  }
  get stableRetrievalOrdering() {
    return this.values.get("stableRetrievalOrdering", false);
  }
  get reuseIdenticalPromptResults() {
    return this.values.get("reuseIdenticalPromptResults", false);
  }
  get identicalPromptCacheTtlMs() {
    return this.number("identicalPromptCacheTtlMs", 5000, 0);
  }
  get autocompleteExclusionPatterns() {
    return this.values.get<string[]>("autocompleteExclusionPatterns", exclusions);
  }
  get autocompleteSnoozeUntil() {
    return this.values.get("autocompleteSnoozeUntil", 0);
  }
  get useCopilotStyleNextEditPresentation() {
    return this.values.get("useCopilotStyleNextEditPresentation", false);
  }
  get completionTimeoutMs() {
    return this.values.get("completionTimeoutMs", 10000);
  }
  get retriggerOnContextExit() {
    return this.values.get("retriggerOnContextExit", false);
  }
  get contextExitRetriggerDebounceMs() {
    return this.number("contextExitRetriggerDebounceMs", 1500, 0);
  }
  get diagRadius() {
    return this.values.get("diagRadius", 12);
  }
  get editableTokens() {
    return this.number("editableTokens", 350, 1);
  }
  get zetaContextTokens() {
    return this.number("zetaContextTokens", 150, 0);
  }
  get rulesMaxChars() {
    return this.values.get("rulesMaxChars", 3000);
  }
  get injectInlineDiagnostics() {
    return this.values.get("injectInlineDiagnostics", false);
  }
  get inlineDiagnosticsMarker() {
    return this.values.get("inlineDiagnosticsMarker", "BUG: LSP error here");
  }
  get diagnosticsMessageTransforms(): MessageTransform[] {
    return Object.entries(
      this.values.get<Record<string, string>>("diagnosticsMessageTransforms", transforms),
    )
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([pattern, replacement]) => ({ pattern, replacement }));
  }
  isAutocompleteSnoozed(now = Date.now()) {
    return this.autocompleteSnoozeUntil > now;
  }
  getAutocompleteSnoozeRemainingMs(now = Date.now()) {
    return this.autocompleteSnoozeUntil ? Math.max(0, this.autocompleteSnoozeUntil - now) : null;
  }
  shouldExcludeFromAutocomplete(filePath: string) {
    const normalized = filePath.replace(/\\/g, "/");
    return this.autocompleteExclusionPatterns.some((raw) => {
      const pattern = raw.trim().replace(/\\/g, "/");
      if (!pattern) return false;
      if (!pattern.includes("*"))
        return path.posix.basename(normalized).endsWith(pattern) || normalized.endsWith(pattern);
      let escaped = "";
      for (let index = 0; index < pattern.length; index++) {
        const character = pattern[index]!;
        if (character === "*") {
          let end = index + 1;
          while (pattern[end] === "*") end++;
          const isGlobstar = end - index > 1;
          if (isGlobstar && pattern[end] === "/") {
            escaped += "(?:.*/)?";
            end++;
          } else {
            escaped += isGlobstar ? ".*" : "[^/]*";
          }
          index = end - 1;
          continue;
        }
        escaped += /[.+^${}()|[\]\\]/.test(character) ? `\\${character}` : character;
      }
      return new RegExp(`^${escaped}$`).test(normalized);
    });
  }
  inspect<T>(key: string) {
    return this.values.inspect<T>(key);
  }
  setEnabled(
    value: boolean,
    target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global,
  ) {
    return this.values.update("enabled", value, target);
  }
  setAutocompleteSnoozeUntil(value: number, target = vscode.ConfigurationTarget.Global) {
    return this.values.update("autocompleteSnoozeUntil", value, target);
  }
}
export const config = new SweepConfig();
