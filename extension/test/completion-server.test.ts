import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { CompletionClient } from "~/api/completion-client.ts";
import { MODEL_NAME, CONTINUATION_MODEL_NAME } from "~/core/constants.ts";
import { CompletionServer } from "~/services/completion-server.ts";
import { grpcServer, final } from "./fixtures/grpc-server.ts";

function configure(values: Record<string, unknown>): void {
  (
    globalThis as typeof globalThis & { __vscodeMockConfiguration?: Record<string, unknown> }
  ).__vscodeMockConfiguration = values;
}

afterEach(() => {
  configure({});
  vi.restoreAllMocks();
});

describe("completion server readiness", () => {
  test("waits for local model provisioning before probing the endpoint", async () => {
    let ready!: () => void;
    const pending = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const provision = vi.fn(() => pending);
    const ping = vi.spyOn(CompletionClient.prototype, "ping").mockResolvedValue(true);
    const server = new CompletionServer("/tmp/nesweep-tests/server.sock", provision);

    const reachable = server.ensureReachable();
    expect(provision).toHaveBeenCalledOnce();
    expect(provision).toHaveBeenCalledWith(true);
    expect(ping).not.toHaveBeenCalled();

    ready();
    await expect(reachable).resolves.toBe(true);
    expect(ping).toHaveBeenCalledOnce();
  });

  test("propagates provisioning failures without attempting a completion probe", async () => {
    const failure = new Error("Install uv to set up the local model server");
    const ping = vi.spyOn(CompletionClient.prototype, "ping").mockResolvedValue(true);
    const provision = vi.fn(() => Promise.reject(failure));
    const server = new CompletionServer("/tmp/nesweep-tests/server.sock", provision);

    await expect(server.waitUntilReady()).rejects.toBe(failure);
    expect(provision).toHaveBeenCalledWith(false);
    expect(ping).not.toHaveBeenCalled();
  });

  test.each([MODEL_NAME, CONTINUATION_MODEL_NAME])(
    "routes %s completion requests to the bundled endpoint despite legacy overrides",
    async (model) => {
      configure({
        serverUrl: "https://models.example/v1",
        manageLocalServer: false,
        modelName: "legacy-zeta",
        continuationModelName: "legacy-qwen",
      });
      let receivedModel: string | undefined;
      const transport = await grpcServer((call) => {
        receivedModel = call.request.model;
        final(call, "routed");
      });
      const server = new CompletionServer(transport.endpoint.socketPath);
      try {
        expect(
          await server.getClient().complete({
            model,
            prompt: "test",
            temperature: 0,
            maxTokens: 1,
            stop: [],
            timeoutMs: 1000,
          }),
        ).toEqual({ text: "routed", finishReason: "stop" });
        expect(receivedModel).toBe(model);
      } finally {
        server.getClient().dispose();
        await transport.close();
      }
    },
  );
});

describe("completion server channel ownership", () => {
  test("reuses its client and closes the channel on server disposal", () => {
    const server = new CompletionServer("/tmp/nesweep-tests/lifecycle.sock");
    const client = server.getClient();
    const close = vi.spyOn(client, "dispose");
    expect(server.getClient()).toBe(client);
    server.dispose();
    expect(close).toHaveBeenCalledOnce();
    expect(() => server.dispose()).not.toThrow();
  });
});
