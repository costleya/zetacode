import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import * as vscode from "vscode";
import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { TracerProvider } from "@opentelemetry/sdk-trace";

import { ApiClient, type AutocompleteInput } from "~/api/client.ts";
import type { CompletionRequest, CompletionResult } from "~/api/completion-client.ts";
import { CONTINUATION_MODEL_NAME, MODEL_NAME } from "~/core/constants.ts";
import type { CompletionServer } from "~/services/completion-server.ts";
import { continuationDocument } from "./fixtures/continuation-document.ts";

function configure(values: Record<string, unknown> = {}) {
  (
    globalThis as typeof globalThis & { __vscodeMockConfiguration?: Record<string, unknown> }
  ).__vscodeMockConfiguration = {
    maxContextFiles: 0,
    outlineSymbols: 0,
    reuseIdenticalPromptResults: false,
    ...values,
  };
}

const noEdit: CompletionResult = { text: "<|marker_1|><|marker_1|>", finishReason: "stop" };
const zetaEdit: CompletionResult = {
  text: "<|marker_1|>\nfunction demo() {\n  return 1;\n}\n<|marker_2|>",
  finishReason: "stop",
};
const continuation: CompletionResult = { text: "return 42;", finishReason: "stop" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(text?: string) {
  vi.useFakeTimers();
  configure();
  const fixture = continuationDocument(text);
  const primary = vi.fn<() => Promise<CompletionResult>>().mockResolvedValue(noEdit);
  const fallback = vi
    .fn<(request: CompletionRequest, signal?: AbortSignal) => Promise<CompletionResult>>()
    .mockResolvedValue(continuation);
  const started = deferred<void>();
  const primaryStarted = deferred<void>();
  const complete = vi.fn((request: CompletionRequest, signal?: AbortSignal) => {
    if (request.model === MODEL_NAME) {
      primaryStarted.resolve();
      return primary();
    }
    started.resolve();
    return fallback(request, signal);
  });
  const server = {
    waitUntilReady: async () => {},
    getClient: () => ({ complete }),
    reportSuccess: vi.fn(),
    reportFailure: vi.fn(),
  };
  const client = new ApiClient(server as unknown as CompletionServer);
  vi.spyOn(client, "getDebugInfo").mockReturnValue("test");
  const input: AutocompleteInput = {
    document: fixture.document,
    position: new vscode.Position(1, 2),
    originalContent: fixture.document.getText(),
    recentChanges: [],
    recentBuffers: [],
    diagnostics: [],
    // Preserve the existing optimized Zeta-first fallback scenarios.
    userActions: [
      {
        action_type: "DELETE_CHAR",
        line_number: 1,
        offset: 2,
        file_path: fixture.document.fileName,
        timestamp: 1,
      },
    ],
    canUseContinuationFallback: () => true,
  };
  const fallbackSignal = () =>
    complete.mock.calls.find(([request]) => request.model !== MODEL_NAME)?.[1];
  return {
    ...fixture,
    client,
    input,
    complete,
    primary,
    fallback,
    started,
    primaryStarted,
    notifyFirstToken: () => complete.mock.calls[0]?.[0].onFirstToken?.(),
    notifyNoEditImpossible: () => complete.mock.calls[0]?.[0].onNoEditImpossible?.(),
    server,
    fallbackSignal,
    primarySignal: () => complete.mock.calls[0]?.[1],
  };
}

afterEach(() => {
  configure();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ApiClient continuation fallback", () => {
  test.each([undefined, false])(
    "starts eligible fallback 80 ms after the first token with legacy continuation setting %j",
    async (legacySetting) => {
      const {
        client,
        input,
        complete,
        primary,
        fallback,
        primaryStarted,
        notifyFirstToken,
        started,
      } = setup();
      configure(legacySetting === undefined ? {} : { continuationFallbackEnabled: legacySetting });
      const pending = deferred<CompletionResult>();
      primary.mockReturnValue(pending.promise);
      const response = client.getAutocomplete(input);
      await primaryStarted.promise;
      expect(complete).toHaveBeenCalledOnce();
      expect(complete.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          model: MODEL_NAME,
          onFirstToken: expect.any(Function),
          onNoEditImpossible: expect.any(Function),
        }),
      );
      expect(fallback).not.toHaveBeenCalled();
      notifyFirstToken();
      await vi.advanceTimersByTimeAsync(79);
      expect(fallback).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await started.promise;
      expect(fallback).toHaveBeenCalledOnce();
      pending.resolve(noEdit);
      expect((await response)?.[0]?.completion).toBe(continuation.text);
      expect(complete).toHaveBeenCalledTimes(2);
    },
  );

  test("tracing preserves the 80 ms first-token fallback and keeps both requests in the completion trace", async () => {
    const { client, input, complete, primary, fallback, primaryStarted, notifyFirstToken } =
      setup();
    const sdk = new TracerProvider();
    const tracer = sdk.getTracer("fallback-test");
    const root = tracer.startSpan("completion", {}, ROOT_CONTEXT);
    const pending = deferred<CompletionResult>();
    primary.mockReturnValue(pending.promise);
    try {
      const response = client.getAutocomplete({
        ...input,
        tracer,
        traceContext: trace.setSpan(ROOT_CONTEXT, root),
      });
      await primaryStarted.promise;
      notifyFirstToken();
      await vi.advanceTimersByTimeAsync(79);
      expect(fallback).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(fallback).toHaveBeenCalledOnce();
      pending.resolve(noEdit);
      expect((await response)?.[0]?.completion).toBe(continuation.text);
      expect(complete).toHaveBeenCalledTimes(2);
      for (const [request] of complete.mock.calls) {
        expect(request.tracer).toBe(tracer);
        expect(trace.getSpanContext(request.traceContext!)?.traceId).toBe(
          root.spanContext().traceId,
        );
      }
    } finally {
      root.end();
      await sdk.shutdown();
    }
  });

  test("confirmed no-edit bypasses the remaining delay and starts Qwen only once", async () => {
    const { client, input, primary, fallback, primaryStarted, notifyFirstToken } = setup();
    const pendingPrimary = deferred<CompletionResult>();
    primary.mockReturnValue(pendingPrimary.promise);
    const result = client.getAutocomplete(input);
    await primaryStarted.promise;
    notifyFirstToken();
    await vi.advanceTimersByTimeAsync(30);
    expect(fallback).not.toHaveBeenCalled();

    pendingPrimary.resolve(noEdit);
    expect((await result)?.[0]?.completion).toBe(continuation.text);
    expect(fallback).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(80);
    notifyFirstToken();
    expect(fallback).toHaveBeenCalledOnce();
  });

  test.each(["timer first", "primary first"])(
    "starts Qwen once when the timer and no-edit result coincide: %s",
    async (order) => {
      const { client, input, primary, fallback, primaryStarted, notifyFirstToken } = setup();
      const pendingPrimary = deferred<CompletionResult>();
      primary.mockReturnValue(pendingPrimary.promise);
      const result = client.getAutocomplete(input);
      await primaryStarted.promise;
      if (order === "primary first") setTimeout(() => pendingPrimary.resolve(noEdit), 80);
      notifyFirstToken();
      if (order === "timer first") setTimeout(() => pendingPrimary.resolve(noEdit), 80);

      await vi.advanceTimersByTimeAsync(80);
      expect((await result)?.[0]?.completion).toBe(continuation.text);
      expect(fallback).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(80);
      expect(fallback).toHaveBeenCalledOnce();
    },
  );

  test.each(["edit", "error", "abort error", "signal", "no-edit-impossible"])(
    "cancels the delayed Qwen launch for primary %s before 80 ms",
    async (outcome) => {
      const {
        client,
        input,
        primary,
        fallback,
        primaryStarted,
        notifyFirstToken,
        notifyNoEditImpossible,
        primarySignal,
      } = setup();
      const pendingPrimary = deferred<CompletionResult>();
      primary.mockReturnValue(pendingPrimary.promise);
      const controller = new AbortController();
      const result = client.getAutocomplete(input, controller.signal);
      await primaryStarted.promise;
      notifyFirstToken();
      await vi.advanceTimersByTimeAsync(79);
      expect(fallback).not.toHaveBeenCalled();

      if (outcome === "no-edit-impossible") notifyNoEditImpossible();
      else if (outcome === "signal") controller.abort();
      else if (outcome === "error") pendingPrimary.reject(new Error("server unavailable"));
      else if (outcome === "abort error")
        pendingPrimary.reject(Object.assign(new Error("primary aborted"), { name: "AbortError" }));
      else pendingPrimary.resolve(zetaEdit);

      await vi.advanceTimersByTimeAsync(1);
      expect(fallback).not.toHaveBeenCalled();
      if (outcome === "no-edit-impossible") {
        expect(primarySignal()?.aborted).toBe(false);
        pendingPrimary.resolve(zetaEdit);
      }
      if (outcome === "signal") pendingPrimary.resolve(noEdit);
      expect((await result)?.[0]?.completion ?? null).toBe(
        outcome === "edit" || outcome === "no-edit-impossible" ? "return 1;" : null,
      );
      notifyFirstToken();
      await vi.advanceTimersByTimeAsync(80);
      expect(fallback).not.toHaveBeenCalled();
    },
  );

  test.each(["cursor", "version", "deadline"])(
    "rechecks %s when the speculative delay expires",
    async (scenario) => {
      const { client, input, primary, fallback, primaryStarted, notifyFirstToken, update } =
        setup();
      configure({ completionTimeoutMs: scenario === "deadline" ? 80 : 1_000 });
      const pendingPrimary = deferred<CompletionResult>();
      primary.mockReturnValue(pendingPrimary.promise);
      let eligible = true;
      input.canUseContinuationFallback = () => eligible;
      const result = client.getAutocomplete(input);
      await primaryStarted.promise;
      notifyFirstToken();
      await vi.advanceTimersByTimeAsync(79);
      if (scenario === "cursor") eligible = false;
      if (scenario === "version") update(input.document.getText() + " ");
      await vi.advanceTimersByTimeAsync(1);
      expect(fallback).not.toHaveBeenCalled();
      pendingPrimary.resolve(noEdit);
      expect(await result).toBeNull();
      expect(fallback).not.toHaveBeenCalled();
    },
  );

  test("subtracts the speculative delay from Qwen's remaining request budget", async () => {
    const { client, input, primary, complete, fallback, primaryStarted, notifyFirstToken } =
      setup();
    configure({ completionTimeoutMs: 1_000 });
    const pendingPrimary = deferred<CompletionResult>();
    primary.mockReturnValue(pendingPrimary.promise);
    const result = client.getAutocomplete(input);
    await primaryStarted.promise;
    await vi.advanceTimersByTimeAsync(100);
    notifyFirstToken();
    await vi.advanceTimersByTimeAsync(80);
    expect(fallback).toHaveBeenCalledOnce();
    expect(complete.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ timeoutMs: 820 }));
    pendingPrimary.resolve(noEdit);
    expect((await result)?.[0]?.completion).toBe(continuation.text);
  });

  test("ignores legacy model aliases, uses raw Qwen FIM, and inserts at the UTF-16 cursor", async () => {
    const { client, input, complete } = setup("// 😀 日本語\n  \n}");
    configure({ modelName: "legacy-zeta-alias", continuationModelName: "local-qwen-alias" });
    const parent = new AbortController();
    const result = await client.getAutocomplete(input, parent.signal);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ model: MODEL_NAME }));
    const [request, signal] = complete.mock.calls[1]!;
    expect(request).toEqual(
      expect.objectContaining({
        model: CONTINUATION_MODEL_NAME,
        prompt: "<|fim_prefix|>// 😀 日本語\n  <|fim_suffix|>\n}<|fim_middle|>",
        maxTokens: 192,
        temperature: 0,
        repeatPenalty: 1.1,
        stop: expect.arrayContaining(["\n\n", "\r\n\r\n", "<|endoftext|>"]),
      }),
    );
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal).not.toBe(parent.signal);
    const options = request as typeof request & { stop: string[]; timeoutMs: number };
    expect(options.stop).not.toContain("\n");
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(options.timeoutMs).toBeLessThanOrEqual(3_000);
    const offset = input.document.offsetAt(input.position);
    expect(result).toEqual([
      expect.objectContaining({ startIndex: offset, endIndex: offset, completion: "return 42;" }),
    ]);
  });

  test.each(["no edit", "valid edit"])(
    "waits 80 ms after the first-token signal, starts once, and gives Zeta precedence for %s",
    async (outcome) => {
      const {
        client,
        input,
        primary,
        fallback,
        started,
        primaryStarted,
        notifyFirstToken,
        fallbackSignal,
      } = setup();
      const pendingPrimary = deferred<CompletionResult>();
      primary.mockReturnValue(pendingPrimary.promise);
      const result = client.getAutocomplete(input);
      await primaryStarted.promise;
      expect(fallback).not.toHaveBeenCalled();
      notifyFirstToken();
      await vi.advanceTimersByTimeAsync(40);
      notifyFirstToken();
      await vi.advanceTimersByTimeAsync(40);
      await started.promise;
      expect(primary).toHaveBeenCalledOnce();
      expect(fallback).toHaveBeenCalledOnce();
      pendingPrimary.resolve(outcome === "valid edit" ? zetaEdit : noEdit);
      expect((await result)?.[0]?.completion).toBe(
        outcome === "valid edit" ? "return 1;" : "return 42;",
      );
      if (outcome === "valid edit") expect(fallbackSignal()?.aborted).toBe(true);
    },
  );

  test("returns a primary edit without waiting for a signaled fallback and aborts it", async () => {
    const { client, input, primary, fallback, primaryStarted, notifyFirstToken, fallbackSignal } =
      setup();
    const pendingPrimary = deferred<CompletionResult>();
    primary.mockReturnValue(pendingPrimary.promise);
    fallback.mockReturnValue(deferred<CompletionResult>().promise);
    const result = client.getAutocomplete(input);
    await primaryStarted.promise;
    notifyFirstToken();
    await vi.advanceTimersByTimeAsync(80);
    pendingPrimary.resolve(zetaEdit);
    expect((await result)?.[0]?.completion).toBe("return 1;");
    expect(fallbackSignal()?.aborted).toBe(true);
  });

  test("aborts only Qwen on no-edit-impossible while the primary remains pending", async () => {
    const {
      client,
      input,
      primary,
      fallback,
      started,
      primaryStarted,
      notifyFirstToken,
      notifyNoEditImpossible,
      fallbackSignal,
      primarySignal,
    } = setup();
    const pendingPrimary = deferred<CompletionResult>();
    const fallbackAborted = deferred<void>();
    primary.mockReturnValue(pendingPrimary.promise);
    fallback.mockImplementation(
      (_request, signal) =>
        new Promise<CompletionResult>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              fallbackAborted.resolve();
              reject(Object.assign(new Error("Qwen aborted"), { name: "AbortError" }));
            },
            { once: true },
          );
        }),
    );
    const parent = new AbortController();
    const result = client.getAutocomplete(input, parent.signal);
    await primaryStarted.promise;
    notifyFirstToken();
    await vi.advanceTimersByTimeAsync(80);
    await started.promise;
    expect(fallbackSignal()?.aborted).toBe(false);

    notifyNoEditImpossible();
    await fallbackAborted.promise;
    expect(fallback).toHaveBeenCalledOnce();
    expect(primarySignal()).toBe(parent.signal);
    expect(parent.signal.aborted).toBe(false);
    expect(fallbackSignal()?.aborted).toBe(true);

    pendingPrimary.resolve(zetaEdit);
    expect((await result)?.[0]?.completion).toBe("return 1;");
  });

  test("suppresses a reordered first-token signal after no-edit-impossible", async () => {
    const {
      client,
      input,
      primary,
      fallback,
      primaryStarted,
      notifyFirstToken,
      notifyNoEditImpossible,
      primarySignal,
    } = setup();
    const pendingPrimary = deferred<CompletionResult>();
    primary.mockReturnValue(pendingPrimary.promise);
    const parent = new AbortController();
    const result = client.getAutocomplete(input, parent.signal);
    await primaryStarted.promise;

    notifyNoEditImpossible();
    notifyFirstToken();
    notifyFirstToken();
    expect(fallback).not.toHaveBeenCalled();
    expect(primarySignal()).toBe(parent.signal);
    expect(parent.signal.aborted).toBe(false);

    pendingPrimary.resolve(zetaEdit);
    expect((await result)?.[0]?.completion).toBe("return 1;");
    expect(fallback).not.toHaveBeenCalled();
  });

  test.each(["edit", "error", "malformed"])(
    "does not start fallback without a signal for primary %s",
    async (outcome) => {
      const { client, input, primary, fallback, notifyFirstToken } = setup();
      if (outcome === "error") primary.mockRejectedValue(new Error("server unavailable"));
      else
        primary.mockResolvedValue(
          outcome === "edit" ? zetaEdit : { text: "<|marker_1|>", finishReason: "stop" },
        );
      await client.getAutocomplete(input);
      expect(fallback).not.toHaveBeenCalled();
      notifyFirstToken();
      expect(fallback).not.toHaveBeenCalled();
    },
  );

  test("older servers start fallback only once the complete valid no-edit response arrives", async () => {
    const { client, input, primary, fallback, primaryStarted } = setup();
    const pending = deferred<CompletionResult>();
    primary.mockReturnValue(pending.promise);
    const result = client.getAutocomplete(input);
    await primaryStarted.promise;
    expect(fallback).not.toHaveBeenCalled();
    pending.resolve(noEdit);
    expect((await result)?.[0]?.completion).toBe(continuation.text);
    expect(fallback).toHaveBeenCalledOnce();
  });

  test.each([
    ["empty", "", "stop"],
    ["unknown marker", "<|marker_99|><|marker_99|>", "stop"],
    ["malformed marker", "<|marker_1|>", "stop"],
    ["extra marker", "<|marker_1|><|marker_1|><|marker_1|>", "stop"],
    ["truncated", noEdit.text, "length"],
    ["unverified finish", noEdit.text, "unknown"],
  ])("discards speculative fallback for %s Zeta output", async (_name, text, finishReason) => {
    const { client, input, primary, primaryStarted, notifyFirstToken, fallbackSignal } = setup();
    const pending = deferred<CompletionResult>();
    primary.mockReturnValue(pending.promise);
    const response = client.getAutocomplete(input);
    await primaryStarted.promise;
    notifyFirstToken();
    await vi.advanceTimersByTimeAsync(80);
    pending.resolve({ text, finishReason });
    const result = await response;
    expect(result?.map((edit) => edit.completion) ?? []).not.toContain(continuation.text);
    expect(fallbackSignal()?.aborted).toBe(true);
  });

  test("does not surface fallback after a primary error", async () => {
    const { client, input, primary, server, primaryStarted, notifyFirstToken, fallbackSignal } =
      setup();
    const pending = deferred<CompletionResult>();
    primary.mockReturnValue(pending.promise);
    const result = client.getAutocomplete(input);
    await primaryStarted.promise;
    notifyFirstToken();
    await vi.advanceTimersByTimeAsync(80);
    pending.reject(new Error("server unavailable"));
    expect(await result).toBeNull();
    expect(server.reportFailure).toHaveBeenCalledOnce();
    expect(fallbackSignal()?.aborted).toBe(true);
  });

  test("a speculative rejection leaves a pending primary edit usable and healthy", async () => {
    const { client, input, primary, fallback, started, primaryStarted, notifyFirstToken, server } =
      setup();
    const pending = deferred<CompletionResult>();
    primary.mockReturnValue(pending.promise);
    fallback.mockRejectedValue(new Error("Qwen unavailable"));
    const result = client.getAutocomplete(input);
    await primaryStarted.promise;
    notifyFirstToken();
    await vi.advanceTimersByTimeAsync(80);
    await started.promise;
    pending.resolve(zetaEdit);
    expect((await result)?.[0]?.completion).toBe("return 1;");
    expect(server.reportFailure).not.toHaveBeenCalled();
  });

  test.each(["absent", "ineligible", "aborted"])(
    "does not dispatch fallback when eligibility is %s",
    async (scenario) => {
      const { client, input, complete, fallback, notifyFirstToken, notifyNoEditImpossible } =
        setup();
      const controller = new AbortController();
      if (scenario === "absent") delete input.canUseContinuationFallback;
      if (scenario === "ineligible") input.canUseContinuationFallback = () => false;
      if (scenario === "aborted") controller.abort();
      expect(await client.getAutocomplete(input, controller.signal)).toBeNull();
      if (scenario !== "aborted") {
        expect(complete.mock.calls[0]?.[0]).toEqual(
          expect.objectContaining({
            onFirstToken: expect.any(Function),
            onNoEditImpossible: expect.any(Function),
          }),
        );
      }
      expect(fallback).not.toHaveBeenCalled();
      notifyFirstToken();
      notifyNoEditImpossible();
      expect(fallback).not.toHaveBeenCalled();
    },
  );

  test.each(["cursor", "version", "aborted", "deadline"])(
    "does not launch on a first-token signal after %s becomes invalid",
    async (scenario) => {
      const { client, input, primary, fallback, primaryStarted, notifyFirstToken, update } =
        setup();
      configure({ completionTimeoutMs: 1_000 });
      let now = 100_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const pending = deferred<CompletionResult>();
      primary.mockReturnValue(pending.promise);
      const controller = new AbortController();
      let eligible = true;
      input.canUseContinuationFallback = () => eligible;
      const result = client.getAutocomplete(input, controller.signal);
      await primaryStarted.promise;
      if (scenario === "cursor") eligible = false;
      if (scenario === "version") update(input.document.getText() + " ");
      if (scenario === "aborted") controller.abort();
      if (scenario === "deadline") now += 1_001;
      notifyFirstToken();
      expect(fallback).not.toHaveBeenCalled();
      pending.resolve(noEdit);
      expect(await result).toBeNull();
      expect(fallback).not.toHaveBeenCalled();
    },
  );

  test.each(["cursor", "version", "aborted"])(
    "discards speculative output when %s changes before Zeta finishes",
    async (scenario) => {
      const {
        client,
        input,
        primary,
        started,
        primaryStarted,
        notifyFirstToken,
        update,
        fallbackSignal,
      } = setup();
      const pending = deferred<CompletionResult>();
      primary.mockReturnValue(pending.promise);
      const controller = new AbortController();
      let eligible = true;
      input.canUseContinuationFallback = () => eligible;
      const result = client.getAutocomplete(input, controller.signal);
      await primaryStarted.promise;
      notifyFirstToken();
      await vi.advanceTimersByTimeAsync(80);
      await started.promise;
      if (scenario === "cursor") eligible = false;
      if (scenario === "version") update(input.document.getText() + " ");
      if (scenario === "aborted") {
        controller.abort();
        expect(fallbackSignal()?.aborted).toBe(true);
      }
      pending.resolve(noEdit);
      expect(await result).toBeNull();
      expect(fallbackSignal()?.aborted).toBe(true);
    },
  );

  test.each(["cursor", "version", "aborted"])(
    "rechecks %s when fallback finishes after the sentinel",
    async (scenario) => {
      const { client, input, primary, fallback, primaryStarted, notifyFirstToken, update } =
        setup();
      const pendingPrimary = deferred<CompletionResult>();
      primary.mockReturnValue(pendingPrimary.promise);
      const pending = deferred<CompletionResult>();
      const sentinelChecked = deferred<void>();
      let dispatched = false;
      fallback.mockImplementation(() => {
        dispatched = true;
        return pending.promise;
      });
      const controller = new AbortController();
      let eligible = true;
      input.canUseContinuationFallback = () => {
        if (dispatched) sentinelChecked.resolve();
        return eligible;
      };
      const result = client.getAutocomplete(input, controller.signal);
      await primaryStarted.promise;
      notifyFirstToken();
      await vi.advanceTimersByTimeAsync(80);
      pendingPrimary.resolve(noEdit);
      await sentinelChecked.promise;
      if (scenario === "cursor") eligible = false;
      if (scenario === "version") update(input.document.getText() + " ");
      if (scenario === "aborted") controller.abort();
      pending.resolve(continuation);
      expect(await result).toBeNull();
    },
  );

  test.each([
    [2_000, 1_400, 600],
    [10_000, 1_400, 3_000],
  ])(
    "caps fallback against total budget %i after first-token delay %i",
    async (budget, delay, expected) => {
      const { client, input, primary, complete, fallback, primaryStarted, notifyFirstToken } =
        setup();
      configure({ completionTimeoutMs: budget });
      let now = 100_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const pending = deferred<CompletionResult>();
      primary.mockReturnValue(pending.promise);
      const result = client.getAutocomplete(input);
      await primaryStarted.promise;
      expect(fallback).not.toHaveBeenCalled();
      now += delay;
      notifyFirstToken();
      pending.resolve(noEdit);
      await result;
      expect(complete.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ timeoutMs: expected }));
    },
  );

  test("discards ready fallback after the overall deadline expires", async () => {
    const { client, input, primary, started, primaryStarted, notifyFirstToken } = setup();
    configure({ completionTimeoutMs: 1_000 });
    let now = 100_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const pending = deferred<CompletionResult>();
    primary.mockReturnValue(pending.promise);
    const result = client.getAutocomplete(input);
    await primaryStarted.promise;
    notifyFirstToken();
    await vi.advanceTimersByTimeAsync(80);
    await started.promise;
    now += 1_001;
    pending.resolve(noEdit);
    expect(await result).toBeNull();
  });

  test("keeps multi-line insertions intact for provider suffix normalization", async () => {
    const { client, input, fallback } = setup();
    const text = "const answer = 42;\n  return answer;\n}";
    fallback.mockResolvedValue({ text, finishReason: "stop" });
    expect((await client.getAutocomplete(input))?.[0]?.completion).toBe(text);
  });

  test("cached primary success remains reachable across repeated fallback failures", async () => {
    const { client, input, primary, fallback, server } = setup();
    configure({ reuseIdenticalPromptResults: true });
    fallback.mockRejectedValue(new Error("Qwen model unavailable"));
    for (let attempt = 0; attempt < 4; attempt++)
      expect(await client.getAutocomplete(input)).toBeNull();
    expect(primary).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledTimes(4);
    expect(server.reportSuccess).toHaveBeenCalledOnce();
    expect(server.reportFailure).not.toHaveBeenCalled();
  });

  test("cached primary edits never dispatch a continuation", async () => {
    const { client, input, primary, fallback } = setup();
    configure({ reuseIdenticalPromptResults: true });
    primary.mockResolvedValue(zetaEdit);
    expect((await client.getAutocomplete(input))?.[0]?.completion).toBe("return 1;");
    expect((await client.getAutocomplete(input))?.[0]?.completion).toBe("return 1;");
    expect(primary).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
  });

  test("starts a fresh continuation from cached primary no-edit without caching Qwen as Zeta", async () => {
    const { client, input, primary, fallback } = setup();
    configure({ reuseIdenticalPromptResults: true });
    fallback
      .mockResolvedValueOnce({ text: "return 1;", finishReason: "stop" })
      .mockResolvedValueOnce({ text: "return 2;", finishReason: "stop" });
    expect((await client.getAutocomplete(input))?.[0]?.completion).toBe("return 1;");
    expect((await client.getAutocomplete(input))?.[0]?.completion).toBe("return 2;");
    expect(primary).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledTimes(2);
  });
});
