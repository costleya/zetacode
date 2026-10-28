import { vi } from "vite-plus/test";

vi.mock("vscode", () => {
  type MockConfiguration = Record<string, unknown>;

  function getMockConfiguration(): MockConfiguration {
    return ((globalThis as typeof globalThis & { __vscodeMockConfiguration?: unknown })
      .__vscodeMockConfiguration ?? {}) as MockConfiguration;
  }

  const noopChannel = {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    append: () => {},
    appendLine: () => {},
    clear: () => {},
    show: () => {},
    hide: () => {},
    dispose: () => {},
    name: "NESweep",
    logLevel: 0,
    onDidChangeLogLevel: () => ({ dispose: () => {} }),
    replace: () => {},
  };

  class FileSystemError extends Error {
    code = "Unknown";

    static FileNotFound(message?: string) {
      const error = new FileSystemError(message);
      error.code = "FileNotFound";
      return error;
    }

    static NoPermissions(message?: string) {
      const error = new FileSystemError(message);
      error.code = "NoPermissions";
      return error;
    }

    static Unavailable(message?: string) {
      const error = new FileSystemError(message);
      error.code = "Unavailable";
      return error;
    }
  }

  return {
    FileSystemError,
    window: {
      createOutputChannel: () => noopChannel,
      activeTextEditor: undefined,
      visibleTextEditors: [],
      state: { focused: true },
      onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
      onDidChangeActiveColorTheme: () => ({ dispose: () => {} }),
      onDidChangeTextEditorSelection: () => ({ dispose: () => {} }),
      createTextEditorDecorationType: () => ({ dispose: () => {} }),
      activeColorTheme: { kind: 1 },
    },
    workspace: {
      textDocuments: [],
      workspaceFolders: undefined,
      getConfiguration: () => ({
        get: <T>(key: string, defaultValue?: T) => {
          const value = getMockConfiguration()[key];
          return value === undefined ? defaultValue : (value as T);
        },
        update: () => Promise.resolve(),
        inspect: () => undefined,
      }),
      getWorkspaceFolder: () => undefined,
      onDidChangeTextDocument: () => ({ dispose: () => {} }),
      onDidSaveTextDocument: () => ({ dispose: () => {} }),
      onDidChangeConfiguration: () => ({ dispose: () => {} }),
      fs: {
        stat: () => Promise.reject(new Error("vscode mock: fs.stat not available")),
        readFile: () => Promise.reject(new Error("vscode mock: fs.readFile not available")),
      },
    },
    extensions: {
      get all() {
        return [];
      },
    },
    languages: {
      registerInlineCompletionItemProvider: () => ({ dispose: () => {} }),
    },
    commands: {
      registerCommand: () => ({ dispose: () => {} }),
      executeCommand: () => Promise.resolve(),
    },
    Uri: {
      parse: (s: string) => ({ scheme: "file", fsPath: s, toString: () => s }),
      file: (s: string) => ({ scheme: "file", fsPath: s, toString: () => s }),
    },
    Range: class {
      constructor(
        public start: unknown,
        public end: unknown,
      ) {}
    },
    Position: class {
      constructor(
        public line: number,
        public character: number,
      ) {}
    },
    Selection: class {
      constructor(
        public anchor: unknown,
        public active: unknown,
      ) {}
    },
    SnippetString: class {
      value: string;
      constructor(value = "") {
        this.value = value;
      }
    },
    InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 },
    InlineCompletionItem: class {
      filterText?: string;
      command?: unknown;
      constructor(
        public insertText: unknown,
        public range?: unknown,
      ) {}
    },
    EventEmitter: class {
      event = () => ({ dispose: () => {} });
      fire() {}
      dispose() {}
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ColorThemeKind: {
      Light: 1,
      Dark: 2,
      HighContrast: 3,
      HighContrastLight: 4,
    },
    TextEditorRevealType: {
      Default: 0,
      InCenter: 1,
      InCenterIfOutsideViewport: 2,
      AtTop: 3,
    },
    TextDocumentChangeReason: { Undo: 1, Redo: 2 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    Diagnostic: class {
      constructor(
        public range: unknown,
        public message: string,
        public severity?: number,
      ) {}
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ThemeColor: class {
      constructor(public id: string) {}
    },
  };
});
