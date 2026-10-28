import { credentials, Metadata, status } from "@grpc/grpc-js";
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Context, Tracer } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { LOCAL_MODEL_NAMES } from "~/core/constants.ts";
import { CompletionServiceClient } from "./generated/completion.ts";
import type { CompletionEvent } from "./generated/completion.ts";

export type CompletionRequest = {
  model: string;
  prompt: string;
  temperature: number;
  repeatPenalty?: number | undefined;
  maxTokens: number;
  stop: string[];
  timeoutMs: number;
  onFirstToken?: () => void;
  onNoEditImpossible?: () => void;
  traceContext?: Context;
  tracer?: Tracer;
};

export type CompletionResult = {
  text: string;
  finishReason: string;
  promptEvalCount?: number;
  evalCount?: number;
};

/** Typed gRPC over the managed runtime's private Unix socket. */
export class CompletionClient {
  private client: CompletionServiceClient | undefined;
  private disposed = false;

  constructor(private readonly endpoint: { socketPath: string }) {}

  private connect(): CompletionServiceClient {
    if (typeof this.endpoint?.socketPath !== "string" || !this.endpoint.socketPath) {
      throw new Error("A Unix socket path is required");
    }
    if (this.disposed) throw new Error("Completion client is disposed");
    if (this.client) return this.client;
    this.client = new CompletionServiceClient(
      `unix:${this.endpoint.socketPath}`,
      credentials.createInsecure(),
      {
        "grpc.max_receive_message_length": 8 * 1024 * 1024,
        "grpc.max_send_message_length": 8 * 1024 * 1024,
        "grpc.enable_retries": 0,
      },
    );
    return this.client;
  }

  async complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    if (signal?.aborted) throw abortError();
    const parentContext = req.traceContext ?? ROOT_CONTEXT;
    const span = req.tracer?.startSpan(
      "nesweep.grpc.complete",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "rpc.system": "grpc",
          "rpc.method": "nesweep.CompletionService/Complete",
          "nesweep.model": LOCAL_MODEL_NAMES.includes(req.model) ? req.model : "unknown",
        },
      },
      parentContext,
    );
    let spanEnded = false;
    const endSpan = (outcome: "completed" | "error" | "cancelled") => {
      if (!span || spanEnded) return;
      spanEnded = true;
      span.setAttribute("nesweep.outcome", outcome);
      if (outcome === "error") span.setStatus({ code: SpanStatusCode.ERROR });
      else if (outcome === "completed") span.setStatus({ code: SpanStatusCode.OK });
      else span.setStatus({ code: SpanStatusCode.UNSET });
      span.end();
    };

    let client: CompletionServiceClient;
    try {
      client = this.connect();
    } catch (error) {
      endSpan("error");
      throw error;
    }

    const spanContext = span ? trace.setSpan(parentContext, span) : parentContext;
    const propagator = new W3CTraceContextPropagator();
    return new Promise((resolve, reject) => {
      let settled = false;
      let finalReceived = false;
      let firstTokenNotified = false;
      let noEditImpossibleNotified = false;
      let call: ReturnType<CompletionServiceClient["complete"]> | undefined;
      let result: CompletionResult | undefined;
      const finish = (error?: Error, outcome?: "completed" | "error" | "cancelled") => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        const finalError =
          error ??
          (result ? undefined : new Error("Completion stream ended without a final result"));
        endSpan(outcome ?? (finalError ? "error" : "completed"));
        if (finalError) reject(finalError);
        else resolve(result!);
      };
      const onAbort = () => {
        finish(abortError(), "cancelled");
        call?.cancel();
      };
      try {
        const metadata = new Metadata();
        propagator?.inject(spanContext, metadata, {
          set: (carrier, key, value) => carrier.set(key, value),
        });
        call = client.complete(
          {
            model: req.model,
            prompt: req.prompt,
            temperature: req.temperature,
            repeatPenalty: req.repeatPenalty ?? 1,
            maxTokens: req.maxTokens,
            stop: req.stop,
            notifyFirstToken: Boolean(req.onFirstToken || span),
            notifyNoEditImpossible: Boolean(req.onNoEditImpossible),
          },
          metadata,
          { deadline: Date.now() + req.timeoutMs },
        );
        call.on("data", (message: CompletionEvent) => {
          if (settled || finalReceived || signal?.aborted) return;
          const event = message.event;
          if (event?.$case === "finalResult") {
            finalReceived = true;
            const final = event.value;
            result = { text: final.text, finishReason: final.finishReason };
            if (final.promptEvalCount !== undefined) {
              result.promptEvalCount = final.promptEvalCount;
              if (Number.isFinite(final.promptEvalCount)) {
                span?.setAttribute("nesweep.prompt_eval_count", final.promptEvalCount);
              }
            }
            if (final.evalCount !== undefined) {
              result.evalCount = final.evalCount;
              if (Number.isFinite(final.evalCount))
                span?.setAttribute("nesweep.eval_count", final.evalCount);
            }
          } else if (event?.$case === "firstToken" && !firstTokenNotified) {
            firstTokenNotified = true;
            span?.addEvent("first_token");
            notify(req.onFirstToken);
          } else if (event?.$case === "noEditImpossible" && !noEditImpossibleNotified) {
            noEditImpossibleNotified = true;
            span?.addEvent("no_edit_impossible");
            notify(req.onNoEditImpossible);
          }
        });
        call.on("error", (error: Error & { code?: number }) => {
          finish(
            error.code === status.DEADLINE_EXCEEDED
              ? new Error(`Completion request timed out after ${req.timeoutMs}ms`)
              : new Error(`Completion request error: ${error.message}`),
          );
        });
        call.on("end", () => finish());
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Completion request failed"));
      }
    });
  }

  /** Return readiness in the shape used by the managed runtime guard. */
  async health(signal?: AbortSignal, timeoutMs = 1500): Promise<unknown> {
    if (signal?.aborted) return null;
    let client: CompletionServiceClient;
    try {
      client = this.connect();
    } catch {
      return null;
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: unknown) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const call = client.health(
        {},
        new Metadata(),
        { deadline: Date.now() + timeoutMs },
        (error, response) => {
          if (error || !response) finish(null);
          else finish({ status: response.ready ? "ok" : "starting", models: response.models });
        },
      );
      const onAbort = () => {
        finish(null);
        call.cancel();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.client?.close();
    this.client = undefined;
  }

  async ping(timeoutMs = 1500): Promise<boolean> {
    const health = (await this.health(undefined, timeoutMs)) as {
      status: string;
      models: string[];
    } | null;
    return (
      health?.status === "ok" && LOCAL_MODEL_NAMES.every((model) => health.models.includes(model))
    );
  }
}

function abortError(): Error {
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}

function notify(callback?: () => void): void {
  try {
    callback?.();
  } catch {
    // Speculative work must not interrupt the primary result.
  }
}
