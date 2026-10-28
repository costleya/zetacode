import * as vscode from "vscode";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

const resources = vi.hoisted(() => ({
  logger: vi.fn(),
  telemetry: vi.fn(),
  tracker: vi.fn(),
  managed: vi.fn(),
  server: vi.fn(),
  api: vi.fn(),
  metrics: vi.fn(),
  provider: vi.fn(),
  status: vi.fn(),
  watcher: vi.fn(),
  ensureReady: vi.fn(),
}));

vi.mock("~/core/logger.ts", () => ({
  initLogger: () => ({}),
  disposeLogger: resources.logger,
  logger: {},
}));
vi.mock("~/core/telemetry.ts", () => ({
  createTelemetry: () => ({ shutdown: resources.telemetry }),
}));
vi.mock("~/telemetry/document-tracker.ts", () => ({
  DocumentTracker: class {
    dispose = resources.tracker;
  },
}));
vi.mock("~/services/managed-local-server.ts", () => ({
  ManagedLocalServer: class {
    socketPath = "test";
    dispose = resources.managed;
    ensureReady = resources.ensureReady;
  },
}));
vi.mock("~/services/completion-server.ts", () => ({
  CompletionServer: class {
    dispose = resources.server;
  },
}));
vi.mock("~/api/client.ts", () => ({
  ApiClient: class {
    dispose = resources.api;
  },
}));
vi.mock("~/telemetry/autocomplete-metrics.ts", () => ({
  AutocompleteMetricsTracker: class {
    dispose = resources.metrics;
  },
}));
vi.mock("~/editor/jump-edit-manager.ts", () => ({ JumpEditManager: class {} }));
vi.mock("~/editor/inline-edit-provider.ts", () => ({
  InlineEditProvider: class {
    dispose = resources.provider;
  },
}));
vi.mock("~/extension/status-bar.ts", () => ({
  ZetacodeStatusBar: class {
    dispose = resources.status;
  },
  registerStatusBarCommands: vi.fn(),
}));

import { activate } from "~/extension/activate.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.values(resources).forEach((mock) => mock.mockClear());
});

describe("activation registration failures", () => {
  test.each(["denied", "unrelated"] as const)(
    "cleans up after %s registration failure",
    (failureKind) => {
      const failure = new Error(
        failureKind === "denied"
          ? "inlineCompletionsAdditions proposed API is not available"
          : "unrelated registration failure",
      );
      const register = vi
        .spyOn(vscode.languages, "registerInlineCompletionItemProvider")
        .mockImplementation(() => {
          throw failure;
        });
      const showError = vi.fn();
      const workspace = vscode.workspace as unknown as Record<string, unknown>;
      const window = vscode.window as unknown as Record<string, unknown>;
      const oldWatcher = workspace["createFileSystemWatcher"];
      const oldError = window["showErrorMessage"];
      workspace["createFileSystemWatcher"] = () => ({ dispose: resources.watcher });
      window["showErrorMessage"] = showError;
      const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
      try {
        let thrown: unknown;
        try {
          activate(context);
        } catch (error) {
          thrown = error;
        }
        if (failureKind === "denied") {
          expect(thrown).toBeInstanceOf(Error);
          expect((thrown as Error).message).toMatch(
            /native inline edit API.*enable-proposed-api.*README/i,
          );
          expect(showError).toHaveBeenCalledExactlyOnceWith((thrown as Error).message);
        } else {
          expect(thrown).toBe(failure);
          expect(showError).toHaveBeenCalledExactlyOnceWith(failure.message);
        }
        expect(register).toHaveBeenCalledOnce();
        expect(register.mock.calls[0]).toHaveLength(3);
        expect(resources.ensureReady).not.toHaveBeenCalled();
        for (const [name, dispose] of Object.entries(resources)) {
          if (name !== "ensureReady") expect(dispose, name).toHaveBeenCalledOnce();
        }
        expect(context.subscriptions).toEqual([]);
      } finally {
        if (oldWatcher === undefined) delete workspace["createFileSystemWatcher"];
        else workspace["createFileSystemWatcher"] = oldWatcher;
        if (oldError === undefined) delete window["showErrorMessage"];
        else window["showErrorMessage"] = oldError;
      }
    },
  );
});
