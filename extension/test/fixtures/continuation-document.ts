import * as vscode from "vscode";

export function continuationDocument(initialText = "function demo() {\n  \n}") {
  let text = initialText;
  const document = {
    uri: vscode.Uri.file("/workspace/example.ts"),
    fileName: "/workspace/example.ts",
    languageId: "typescript",
    version: 2,
    get lineCount() {
      return text.split("\n").length;
    },
    getText(range?: vscode.Range) {
      return range
        ? text.slice(document.offsetAt(range.start), document.offsetAt(range.end))
        : text;
    },
    lineAt(line: number) {
      return { text: text.split("\n")[line] ?? "" };
    },
    offsetAt(position: vscode.Position) {
      return (
        text
          .split("\n")
          .slice(0, position.line)
          .reduce((offset, line) => offset + line.length + 1, 0) + position.character
      );
    },
    positionAt(offset: number) {
      const prefix = text.slice(0, offset).split("\n");
      return new vscode.Position(prefix.length - 1, prefix.at(-1)?.length ?? 0);
    },
  };
  return {
    document: document as unknown as vscode.TextDocument,
    update: (nextText: string) => {
      text = nextText;
      document.version++;
    },
  };
}
