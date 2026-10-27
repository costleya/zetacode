import * as vscode from "vscode";
let channel: vscode.LogOutputChannel | undefined;
export function initLogger(): vscode.LogOutputChannel {
  return (channel ??= vscode.window.createOutputChannel("NESweep", { log: true }));
}
export function disposeLogger(): void {
  channel?.dispose();
  channel = undefined;
}
function format(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
function write(level: "trace" | "debug" | "info" | "warn" | "error", args: unknown[]): void {
  channel?.[level](args.map(format).join(" "));
}
export const logger = {
  trace: (...args: unknown[]) => write("trace", args),
  debug: (...args: unknown[]) => write("debug", args),
  info: (...args: unknown[]) => write("info", args),
  warn: (...args: unknown[]) => write("warn", args),
  error: (...args: unknown[]) => write("error", args),
};
