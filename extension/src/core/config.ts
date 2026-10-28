import * as path from "node:path";
import * as vscode from "vscode";
import {
  DEFAULT_MAX_CONTEXT_FILES,
  DEFAULT_MAX_RECENT_CHANGES_CHARS,
  DEFAULT_EDITABLE_TOKEN_BUDGET,
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  DEFAULT_DIAGNOSTIC_RADIUS_LINES,
} from "./constants.ts";

export type MessageTransform = {
  pattern: string;
  replacement: string;
};
const exclusions = [
  "**/.env*",
  "**/*.pem",
  "**/*.key",
  "**/*.cert",
  "**/*.crt",
  "**/.dev.vars",
  "**/secrets.yml",
];
export class ZetacodeConfig {
  private get values() {
    return vscode.workspace.getConfiguration("zetacode");
  }
  private number(key: string, fallback: number, min: number) {
    const value = this.values.get<number>(key, fallback);
    return Number.isFinite(value) ? Math.max(min, Math.floor(value)) : fallback;
  }
  get enabled() {
    return this.values.get("enabled", true);
  }
  get maxContextFiles() {
    return this.number("maxContextFiles", DEFAULT_MAX_CONTEXT_FILES, 0);
  }
  get outlineSymbols() {
    return this.number("outlineSymbols", 0, 0);
  }
  get maxEditHistory() {
    return this.number("maxEditHistory", 15, 1);
  }
  get maxRecentChangesChars() {
    return this.number("maxRecentChangesChars", DEFAULT_MAX_RECENT_CHANGES_CHARS, 0);
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
    return this.values.get("diagRadius", DEFAULT_DIAGNOSTIC_RADIUS_LINES);
  }
  get editableTokens() {
    return this.number("editableTokens", DEFAULT_EDITABLE_TOKEN_BUDGET, 1);
  }
  get zetaContextTokens() {
    return this.number("zetaContextTokens", DEFAULT_CONTEXT_TOKEN_BUDGET, 0);
  }
  get injectInlineDiagnostics() {
    return this.values.get("injectInlineDiagnostics", false);
  }
  get inlineDiagnosticsMarker() {
    return this.values.get("inlineDiagnosticsMarker", "BUG: LSP error here");
  }
  get diagnosticsMessageTransforms(): MessageTransform[] {
    return Object.entries(
      this.values.get<Record<string, string>>("diagnosticsMessageTransforms", {}),
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
export const config = new ZetacodeConfig();
