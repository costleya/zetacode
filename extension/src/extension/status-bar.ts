import * as vscode from "vscode";
import { config } from "~/core/config.ts";
import type { CompletionServer } from "~/services/completion-server.ts";

export class SweepStatusBar implements vscode.Disposable {
  private item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private listener: vscode.Disposable;
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  constructor(_context: vscode.ExtensionContext) {
    this.item.command = "sweep.showMenu";
    this.listener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("sweep.enabled") ||
        e.affectsConfiguration("sweep.autocompleteSnoozeUntil")
      )
        this.render();
    });
    this.render();
    this.item.show();
  }
  setProcessing(active: boolean): void {
    if (active && !this.timer)
      this.timer = setInterval(() => {
        this.frame = (this.frame % 4) + 1;
        this.render();
      }, 150);
    if (!active && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.frame = 0;
    }
    this.render();
  }
  private render(): void {
    const snoozed = config.isAutocompleteSnoozed();
    this.item.text = `$(${this.timer ? `nesweep-load-${this.frame || 1}` : "nesweep-idle"}) NESweep`;
    this.item.tooltip = `NESweep: ${config.enabled ? "enabled" : "disabled"}\n${snoozed ? `Paused until ${new Date(config.autocompleteSnoozeUntil).toLocaleString()}` : "Not paused"}`;
    this.item.backgroundColor =
      !config.enabled || snoozed
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
  }
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.listener.dispose();
    this.item.dispose();
  }
}
export function registerStatusBarCommands(
  _context: vscode.ExtensionContext,
  server: CompletionServer,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("sweep.toggleEnabled", async () => {
      const wasEnabled = config.enabled;
      await config.setEnabled(!wasEnabled);
      if (wasEnabled) await vscode.commands.executeCommand("editor.action.inlineSuggest.hide");
    }),
    vscode.commands.registerCommand("sweep.showMenu", async () => {
      const items: Array<vscode.QuickPickItem & { action: string }> = [
        { label: config.enabled ? "Disable suggestions" : "Enable suggestions", action: "toggle" },
        {
          label: config.isAutocompleteSnoozed() ? "Resume suggestions" : "Pause suggestions",
          action: config.isAutocompleteSnoozed() ? "resume" : "pause",
        },
        { label: "Check local models", action: "check" },
      ];
      const selected = await vscode.window.showQuickPick(items, { title: "NESweep" });
      switch (selected?.action) {
        case "toggle":
          await vscode.commands.executeCommand("sweep.toggleEnabled");
          break;
        case "resume":
          await config.setAutocompleteSnoozeUntil(0);
          break;
        case "pause": {
          const duration = await vscode.window.showQuickPick(
            [
              { label: "15 minutes", minutes: 15 },
              { label: "30 minutes", minutes: 30 },
              { label: "1 hour", minutes: 60 },
              { label: "4 hours", minutes: 240 },
            ],
            { title: "Pause suggestions" },
          );
          if (duration) {
            await config.setAutocompleteSnoozeUntil(Date.now() + duration.minutes * 60000);
            await vscode.commands.executeCommand("editor.action.inlineSuggest.hide");
          }
          break;
        }
        case "check":
          if (await server.ensureReachable())
            void vscode.window.showInformationMessage("NESweep local models are ready.");
          break;
      }
    }),
  ];
}
