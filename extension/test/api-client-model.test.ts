import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import * as vscode from "vscode";

import { ApiClient } from "~/api/client.ts";
import type { CompletionRequest, CompletionResult } from "~/api/completion-client.ts";
import { ZETA_EOS } from "~/api/prompt.ts";
import { MODEL_NAME } from "~/core/constants.ts";
import type { CompletionServer } from "~/services/completion-server.ts";

function setConfiguration(values: Record<string, unknown>): void {
  (
    globalThis as typeof globalThis & {
      __vscodeMockConfiguration?: Record<string, unknown>;
    }
  ).__vscodeMockConfiguration = values;
}

afterEach(() => {
  setConfiguration({});
  vi.restoreAllMocks();
});

describe("ApiClient model protocol", () => {
  test.each([undefined, "local-model-alias", "sweepai/sweep-next-edit"])(
    "uses bundled Zeta 2.1 despite legacy model setting %j",
    async (modelName) => {
      setConfiguration({ modelName, maxContextFiles: 0, outlineSymbols: 0 });
      const text = "before\nold();\nafter\n";
      const lines = text.split("\n");
      const offsetAt = (position: vscode.Position) =>
        lines.slice(0, position.line).reduce((length, line) => length + line.length + 1, 0) +
        position.character;
      const document = {
        uri: vscode.Uri.file("/workspace/example.ts"),
        languageId: "typescript",
        lineCount: lines.length,
        getText: (range?: vscode.Range) =>
          range ? text.slice(offsetAt(range.start), offsetAt(range.end)) : text,
        lineAt: (line: number) => ({ text: lines[line] ?? "" }),
        offsetAt,
      } as unknown as vscode.TextDocument;
      const complete = vi
        .fn<(request: CompletionRequest, signal?: AbortSignal) => Promise<CompletionResult>>()
        .mockResolvedValue({
          text: `<|marker_1|>\nbefore\nnew();\nafter\n<|marker_2|>${ZETA_EOS}`,
          finishReason: "stop",
        });
      const server = {
        waitUntilReady: async () => {},
        getClient: () => ({ complete }),
        reportSuccess: vi.fn(),
        reportFailure: vi.fn(),
      };
      const client = new ApiClient(server as unknown as CompletionServer);
      vi.spyOn(client, "getDebugInfo").mockReturnValue("test");

      const result = await client.getAutocomplete({
        document,
        position: new vscode.Position(1, 0),
        originalContent: text,
        recentChanges: [],
        recentBuffers: [],
        diagnostics: [],
        userActions: [],
      });

      expect(complete).toHaveBeenCalledOnce();
      expect(complete).toHaveBeenCalledWith(
        expect.objectContaining({
          model: MODEL_NAME,
          stop: [ZETA_EOS],
          prompt: expect.stringContaining(
            "<|marker_1|>\nbefore\n<|user_cursor|>old();\nafter\n<|marker_2|>",
          ),
        }),
        undefined,
      );
      expect(result).toEqual([
        expect.objectContaining({
          startIndex: "before\n".length,
          endIndex: "before\nold();".length,
          completion: "new();",
        }),
      ]);
      expect(server.reportSuccess).toHaveBeenCalledOnce();
      expect(server.reportFailure).not.toHaveBeenCalled();
    },
  );
});
