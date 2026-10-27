import * as vscode from "vscode";
import { config } from "~/core/config.ts";

export class RulesDiagnostics implements vscode.Disposable {
  private collection = vscode.languages.createDiagnosticCollection("nesweep-rules");
  private decoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("inputValidation.errorBackground"),
  });
  private subscriptions: vscode.Disposable[];
  constructor() {
    this.subscriptions = [
      vscode.workspace.onDidOpenTextDocument((d) => this.update(d)),
      vscode.workspace.onDidChangeTextDocument((e) => this.update(e.document)),
      vscode.workspace.onDidCloseTextDocument((d) => this.collection.delete(d.uri)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("sweep.rulesMaxChars")) this.refresh();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
    ];
    this.refresh();
  }
  private refresh() {
    for (const doc of vscode.workspace.textDocuments) this.update(doc);
  }
  private update(doc: vscode.TextDocument) {
    if (!/\/\.vscode\/nes-[^/]+\.md$/.test(doc.uri.path)) return;
    const limit = config.rulesMaxChars,
      length = doc.getText().length;
    const over = limit > 0 && length > limit;
    const range = over
      ? new vscode.Range(doc.positionAt(limit), doc.positionAt(length))
      : undefined;
    this.collection.set(
      doc.uri,
      range
        ? [
            new vscode.Diagnostic(
              range,
              `Language instructions exceed the ${limit} character limit.`,
              vscode.DiagnosticSeverity.Warning,
            ),
          ]
        : [],
    );
    for (const editor of vscode.window.visibleTextEditors)
      if (editor.document === doc) editor.setDecorations(this.decoration, range ? [range] : []);
  }
  dispose() {
    this.subscriptions.forEach((s) => s.dispose());
    this.collection.dispose();
    this.decoration.dispose();
  }
}
