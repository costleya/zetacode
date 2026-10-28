import { getEventListeners } from "node:events";
import { status } from "@grpc/grpc-js";
import { CompletionServiceClient } from "~/api/generated/completion.ts";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { CompletionClient, type CompletionRequest } from "~/api/completion-client.ts";
import {
  deferred,
  dualModels,
  final,
  firstToken,
  grpcServer,
  noEditImpossible,
  type CompletionCall,
} from "./fixtures/grpc-server.ts";

const resources: Array<{ close(): Promise<void> | void }> = [];
afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) await resource.close();
  vi.restoreAllMocks();
});
async function listen(...args: Parameters<typeof grpcServer>) {
  const server = await grpcServer(...args);
  resources.push(server);
  const client = new CompletionClient(server.endpoint);
  resources.push({ close: () => client.dispose() });
  return client;
}
const options: CompletionRequest = {
  model: "zeta-2.1",
  prompt: "prompt",
  temperature: 0,
  maxTokens: 32,
  stop: [],
  timeoutMs: 2_000,
};

describe("CompletionClient over Unix gRPC", () => {
  test.each([
    { model: "zeta-2.1", repeatPenalty: undefined, expectedPenalty: 1 },
    { model: "qwen2.5-coder-7b-instruct", repeatPenalty: 1.1, expectedPenalty: 1.1 },
  ])(
    "preserves raw prompt and sampling options for $model",
    async ({ model, repeatPenalty, expectedPenalty }) => {
      const received = deferred<CompletionCall>();
      const client = await listen((call) => {
        received.resolve(call);
        final(call, "raw <|marker_1|>text", "length", { promptEvalCount: 17, evalCount: 9 });
      });
      const result = await client.complete({
        ...options,
        model,
        prompt: "π <|fim_prefix|>const x = <|fim_suffix|>;<|fim_middle|>",
        temperature: 0.25,
        repeatPenalty,
        maxTokens: 47,
        stop: ["END", "\n\n"],
      });
      expect((await received.promise).request).toEqual({
        model,
        prompt: "π <|fim_prefix|>const x = <|fim_suffix|>;<|fim_middle|>",
        temperature: 0.25,
        repeatPenalty: expectedPenalty,
        maxTokens: 47,
        stop: ["END", "\n\n"],
        notifyFirstToken: false,
        notifyNoEditImpossible: false,
      });
      expect(result).toEqual({
        text: "raw <|marker_1|>text",
        finishReason: "length",
        promptEvalCount: 17,
        evalCount: 9,
      });
    },
  );
  test.each(["first", "impossible"] as const)(
    "deduplicates opt-in milestones before final with %s first",
    async (order) => {
      const signalled = deferred();
      const release = deferred();
      const calls: string[] = [];
      const client = await listen((call) => {
        expect(call.request.notifyFirstToken).toBe(true);
        expect(call.request.notifyNoEditImpossible).toBe(true);
        const send =
          order === "first" ? [firstToken, noEditImpossible] : [noEditImpossible, firstToken];
        for (const emit of [...send, ...send]) emit(call);
        void release.promise.then(() => final(call));
      });
      let settled = false;
      const result = client.complete({
        ...options,
        onFirstToken: () => {
          calls.push("first");
          if (calls.length === 2) signalled.resolve();
        },
        onNoEditImpossible: () => {
          calls.push("impossible");
          if (calls.length === 2) signalled.resolve();
        },
      });
      void result.then(() => {
        settled = true;
      });
      await signalled.promise;
      expect(calls).toEqual(order === "first" ? ["first", "impossible"] : ["impossible", "first"]);
      expect(settled).toBe(false);
      release.resolve();
      expect(await result).toEqual({ text: "complete output", finishReason: "stop" });
    },
  );
  test("preserves an explicit empty finish reason and absent optional usage", async () => {
    const client = await listen((call) => final(call, "<|marker_1|><|marker_1|>", ""));
    expect(await client.complete(options)).toEqual({
      text: "<|marker_1|><|marker_1|>",
      // The proto string preserves an explicit empty reason; it is not a verified stop.
      finishReason: "",
    });
  });
  test("preserves explicit zero tokens and zero usage counts", async () => {
    const client = await listen((call) => {
      expect(call.request.maxTokens).toBe(0);
      final(call, "", "length", { promptEvalCount: 0, evalCount: 0 });
    });
    expect(await client.complete({ ...options, maxTokens: 0 })).toEqual({
      text: "",
      finishReason: "length",
      promptEvalCount: 0,
      evalCount: 0,
    });
  });
  test("a terminal RPC error after final still rejects the request", async () => {
    const client = await listen((call) => {
      call.write({
        event: {
          $case: "finalResult",
          value: { text: "incomplete transport", finishReason: "stop" },
        },
      });
      call.emit(
        "error",
        Object.assign(new Error("stream failed after final"), { code: status.INTERNAL }),
      );
    });
    await expect(client.complete(options)).rejects.toThrow(/stream failed after final/);
  });
  test("ignores unsolicited milestones when no observers opted in", async () => {
    const client = await listen((call) => {
      expect(call.request.notifyFirstToken).toBe(false);
      expect(call.request.notifyNoEditImpossible).toBe(false);
      firstToken(call);
      noEditImpossible(call);
      final(call);
    });
    expect(await client.complete(options)).toEqual({
      text: "complete output",
      finishReason: "stop",
    });
  });
  test.each(["first", "impossible"] as const)("isolates a throwing %s observer", async (which) => {
    const observer = vi.fn(() => {
      throw new Error("observer failure");
    });
    const client = await listen((call) => {
      firstToken(call);
      noEditImpossible(call);
      final(call);
    });
    expect(
      await client.complete({
        ...options,
        ...(which === "first" ? { onFirstToken: observer } : { onNoEditImpossible: observer }),
      }),
    ).toEqual({ text: "complete output", finishReason: "stop" });
    expect(observer).toHaveBeenCalledOnce();
  });
  test("abort from first token suppresses subsequent progress and result, then recovers", async () => {
    const cancelled = deferred();
    const controller = new AbortController();
    const impossible = vi.fn();
    const client = await listen((call) => {
      if (call.request.prompt === "recovery") {
        final(call, "recovered");
        return;
      }
      call.on("cancelled", () => cancelled.resolve());
      firstToken(call);
      noEditImpossible(call);
      final(call, "stale output");
    });
    await expect(
      client.complete(
        { ...options, onFirstToken: () => controller.abort(), onNoEditImpossible: impossible },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    await cancelled.promise;
    expect(impossible).not.toHaveBeenCalled();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(await client.complete({ ...options, prompt: "recovery" })).toEqual({
      text: "recovered",
      finishReason: "stop",
    });
  });
  test.each(["abort", "deadline"] as const)(
    "%s remains effective after progress and cancels server work",
    async (reason) => {
      const received = deferred();
      const cancelled = deferred();
      const controller = new AbortController();
      const client = await listen((call) => {
        call.on("cancelled", () => cancelled.resolve());
        firstToken(call);
      });
      const result = client.complete(
        {
          ...options,
          timeoutMs: reason === "deadline" ? 100 : 2000,
          onFirstToken: () => received.resolve(),
        },
        controller.signal,
      );
      const assertion =
        reason === "abort"
          ? expect(result).rejects.toMatchObject({ name: "AbortError" })
          : expect(result).rejects.toThrow(/timed out|deadline/i);
      await received.promise;
      if (reason === "abort") controller.abort();
      await assertion;
      await cancelled.promise;
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    },
  );
  test("an already aborted request does not dispatch", async () => {
    const handler = vi.fn((call: CompletionCall) => final(call));
    const client = await listen(handler);
    const controller = new AbortController();
    controller.abort();
    await expect(client.complete(options, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(handler).not.toHaveBeenCalled();
  });
  test("rejects stream errors and streams that end without a result", async () => {
    const client = await listen((call) => {
      if (call.request.prompt === "error")
        call.emit(
          "error",
          Object.assign(new Error("invalid options"), { code: status.INVALID_ARGUMENT }),
        );
      else call.end();
    });
    await expect(client.complete({ ...options, prompt: "error" })).rejects.toThrow(
      /invalid options/i,
    );
    await expect(client.complete(options)).rejects.toThrow(/final|result|completion/i);
  });
  test("isolates simultaneous completions and readiness on one client", async () => {
    const pending = new Map<string, CompletionCall>();
    const both = deferred();
    const client = await listen((call) => {
      pending.set(call.request.prompt, call);
      if (pending.size === 2) both.resolve();
    });
    const one = client.complete({ ...options, prompt: "one" });
    const two = client.complete({ ...options, prompt: "two" });
    await both.promise;
    expect(await client.health()).toEqual({ status: "ok", models: dualModels });
    expect(await client.ping()).toBe(true);
    final(pending.get("two")!, "two");
    final(pending.get("one")!, "one");
    expect(await Promise.all([one, two])).toEqual([
      { text: "one", finishReason: "stop" },
      { text: "two", finishReason: "stop" },
    ]);
  });
  test("releases AbortSignal listeners after success", async () => {
    const client = await listen((call) => final(call));
    const controller = new AbortController();
    await client.complete(options, controller.signal);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    await client.health(controller.signal);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
  test.each([
    { ready: false, models: dualModels },
    { ready: true, models: [dualModels[0]!] },
    { ready: true, models: [dualModels[1]!] },
  ])("requires both model IDs for readiness: %j", async (health) => {
    const client = await listen(
      (call) => final(call),
      (_call, callback) => callback(null, health),
    );
    expect(await client.ping()).toBe(false);
  });
  test.each(["abort", "deadline"] as const)(
    "health %s returns null and removes listener",
    async (reason) => {
      const received = deferred();
      const cancelled = deferred();
      const client = await listen(
        (call) => final(call),
        (call, _callback) => {
          call.on("cancelled", () => cancelled.resolve());
          received.resolve();
        },
      );
      const controller = new AbortController();
      const result = client.health(controller.signal, reason === "deadline" ? 100 : 2000);
      await received.promise;
      if (reason === "abort") controller.abort();
      expect(await result).toBeNull();
      await cancelled.promise;
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    },
  );
  test("unavailable Unix endpoint fails completion and readiness", async () => {
    const client = new CompletionClient({ socketPath: "/tmp/zetacode-grpc-test-nonexistent.sock" });
    resources.push({ close: () => client.dispose() });
    await expect(client.complete({ ...options, timeoutMs: 100 })).rejects.toThrow();
    expect(await client.health(undefined, 100)).toBeNull();
    expect(await client.ping(100)).toBe(false);
  });
  test("cancelling one stream preserves its sibling on the shared channel", async () => {
    const received = new Map<string, CompletionCall>();
    const both = deferred();
    const cancelled = deferred();
    const client = await listen((call) => {
      received.set(call.request.prompt, call);
      call.on("cancelled", () => {
        if (call.request.prompt === "cancel") cancelled.resolve();
      });
      if (received.size === 2) both.resolve();
    });
    const controller = new AbortController();
    const first = client.complete({ ...options, prompt: "cancel" }, controller.signal);
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const second = client.complete({ ...options, prompt: "keep" });
    await both.promise;
    controller.abort();
    await rejected;
    await cancelled.promise;
    expect(received.get("keep")!.cancelled).toBe(false);
    final(received.get("keep")!, "survived");
    expect(await second).toEqual({ text: "survived", finishReason: "stop" });
  });
  test("reuses one channel and closes it once even when disposed repeatedly", async () => {
    const close = vi.spyOn(CompletionServiceClient.prototype, "close");
    const client = await listen((call) => final(call));
    await client.health();
    await client.complete(options);
    await client.ping();
    expect(close).not.toHaveBeenCalled();
    client.dispose();
    client.dispose();
    expect(close).toHaveBeenCalledOnce();
    await expect(client.complete(options)).rejects.toThrow(/disposed/i);
    expect(await client.health()).toBeNull();
  });
  test("dispose rejects pending calls and releases their abort listeners", async () => {
    const received = deferred();
    const client = await listen((_call) => received.resolve());
    const controller = new AbortController();
    const pending = client.complete(options, controller.signal);
    const rejected = expect(pending).rejects.toThrow();
    await received.promise;
    client.dispose();
    await rejected;
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
  test("progress after final cannot trigger new speculative work", async () => {
    const first = vi.fn();
    const impossible = vi.fn();
    const client = await listen((call) => {
      call.write({
        event: { $case: "finalResult", value: { text: "final", finishReason: "stop" } },
      });
      firstToken(call);
      noEditImpossible(call);
      call.end();
    });
    expect(
      await client.complete({ ...options, onFirstToken: first, onNoEditImpossible: impossible }),
    ).toEqual({ text: "final", finishReason: "stop" });
    expect(first).not.toHaveBeenCalled();
    expect(impossible).not.toHaveBeenCalled();
  });
});
