import * as vscode from "vscode";
import { ApiClient } from "~/api/client.ts";
import { config } from "~/core/config.ts";
import { disposeLogger, initLogger, logger } from "~/core/logger.ts";
import { createTelemetry, type ExtensionTelemetry } from "~/core/telemetry.ts";
import { InlineEditProvider } from "~/editor/inline-edit-provider.ts";
import { JumpEditManager } from "~/editor/jump-edit-manager.ts";
import { registerInlineCompletionItemProviderWithMetadata } from "~/editor/proposed-inline-edit.ts";
import {
  initSyntaxHighlighter,
  reloadTheme,
  onDidChangeSyntaxHighlighting,
} from "~/editor/syntax-highlight-renderer.ts";
import { RulesDiagnostics } from "~/extension/rules-diagnostics.ts";
import { registerStatusBarCommands, SweepStatusBar } from "~/extension/status-bar.ts";
import { ManagedLocalServer } from "~/services/managed-local-server.ts";
import { CompletionServer } from "~/services/completion-server.ts";
import {
  AutocompleteMetricsTracker,
  type AutocompleteMetricsPayload,
} from "~/telemetry/autocomplete-metrics.ts";
import { DocumentTracker } from "~/telemetry/document-tracker.ts";

let tracker: DocumentTracker | undefined;
let telemetry: ExtensionTelemetry | undefined;
let provider: InlineEditProvider | undefined;
let jump: JumpEditManager | undefined;
let api: ApiClient | undefined;
let managed: ManagedLocalServer | undefined;
let server: CompletionServer | undefined;
let warned = false;
export function activate(context: vscode.ExtensionContext): void {
  const output = initLogger();
  telemetry = createTelemetry();
  initSyntaxHighlighter();
  tracker = new DocumentTracker(context);
  managed = new ManagedLocalServer(context, output);
  server = new CompletionServer(managed.socketPath, (retry) => managed!.ensureReady(retry));
  api = new ApiClient(server);
  const metrics = new AutocompleteMetricsTracker();
  jump = new JumpEditManager(metrics);
  provider = new InlineEditProvider(tracker, jump, api, metrics, telemetry);
  const status = new SweepStatusBar(context);
  const diagnostics = new RulesDiagnostics();
  const refreshTheme = () => {
    reloadTheme();
    jump?.refreshJumpEditDecorations();
  };
  const warnProposal = () => {
    if (!config.useCopilotStyleNextEditPresentation) {
      warned = false;
      return;
    }
    if (!warned) {
      warned = true;
      void vscode.window.showWarningMessage(
        "Experimental next-edit presentation requires VS Code Insiders started with --enable-proposed-api=s-obvious.nesweep.",
      );
    }
  };
  warnProposal();
  const move = (editor: vscode.TextEditor) => {
    void provider?.handleCursorMove(editor.document, editor.selection.active);
    jump?.handleCursorMove(editor.selection.active);
  };
  const activateEditor = (editor: vscode.TextEditor | undefined) => {
    tracker?.setActiveFile(editor?.document ?? null);
    if (editor) {
      void tracker?.trackFileVisit(editor.document);
      void api?.refreshOutline(editor.document);
      move(editor);
    }
  };
  const fileWatcher = vscode.workspace.createFileSystemWatcher("**/*");
  context.subscriptions.push(
    registerInlineCompletionItemProviderWithMetadata({ pattern: "**/*" }, provider, {
      groupId: "nesweep",
      displayName: "NESweep",
    }),
    vscode.commands.registerCommand("sweep.triggerNextEdit", () =>
      vscode.commands.executeCommand("editor.action.inlineSuggest.trigger"),
    ),
    vscode.commands.registerCommand("sweep.acceptJumpEdit", () => jump?.acceptJumpEdit()),
    vscode.commands.registerCommand("sweep.dismissJumpEdit", () => jump?.dismissJumpEdit()),
    vscode.commands.registerCommand(
      "sweep.acceptInlineEdit",
      (
        payload: AutocompleteMetricsPayload | undefined,
        suggestion:
          | { id: string; startIndex: number; endIndex: number; completion: string }
          | undefined,
      ) => {
        if (payload) {
          provider?.handleInlineAccept(payload, suggestion);
          metrics.trackAccepted(payload);
        }
      },
    ),
    ...registerStatusBarCommands(context, server),
    api.onProcessingChange((active) => status.setProcessing(active)),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === vscode.window.activeTextEditor?.document) tracker?.trackChange(event);
      telemetry?.recordDocumentChange(event.document);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      void api?.refreshOutline(document);
    }),
    fileWatcher,
    fileWatcher.onDidDelete((uri) => tracker?.forgetFile(uri)),
    vscode.window.onDidChangeActiveTextEditor(activateEditor),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor !== vscode.window.activeTextEditor) return;
      tracker?.trackSelectionChange(event.textEditor.document, event.selections);
      for (const selection of event.selections)
        tracker?.trackCursorMovement(event.textEditor.document, selection.active);
      move(event.textEditor);
    }),
    vscode.window.onDidChangeActiveColorTheme(refreshTheme),
    onDidChangeSyntaxHighlighting(refreshTheme),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("sweep.useCopilotStyleNextEditPresentation")) warnProposal();
      if (event.affectsConfiguration("workbench.colorTheme")) setTimeout(refreshTheme, 0);
    }),
    tracker,
    jump,
    metrics,
    status,
    diagnostics,
    managed,
    server,
  );
  activateEditor(vscode.window.activeTextEditor);
  void managed.ensureReady().catch((error) => logger.warn("Local model preparation failed", error));
}
export async function deactivate(): Promise<void> {
  await tracker?.flush();
  provider?.dispose();
  jump?.dispose();
  api?.dispose();
  server?.dispose();
  managed?.dispose();
  await telemetry?.shutdown();
  disposeLogger();
}
