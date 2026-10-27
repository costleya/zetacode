import * as os from "node:os";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Context, Tracer } from "@opentelemetry/api";
import { MODEL_NAME, CONTINUATION_MODEL_NAME, MAX_TOKENS, TEMPERATURE } from "~/core/constants.ts";
import {
  buildContinuationPrompt,
  parseContinuation,
  isZetaNoEditResponse,
  CONTINUATION_STOP_TOKENS,
} from "./continuation.ts";
import { config } from "~/core/config.ts";
import { toUnixPath } from "~/utils/path.ts";
import { isFileTooLarge, utf8ByteOffsetAt } from "~/utils/text.ts";
import { CompletionCache } from "./completion-cache.ts";
import { formatRecentChanges } from "./history.ts";
import { parseZetaResponse } from "./parser.ts";
import { classifyCompletionRoute, isMeaningfulZetaUpgrade } from "./completion-routing.ts";
import { buildZetaPrompt } from "./prompt.ts";
import {
  buildRecentBufferChunks,
  buildRetrievalChunks,
  type RetrievalFileLoader,
} from "./retrieval-chunks.ts";
import { getCommentPrefix, loadWorkspaceRules } from "./rules.ts";
import {
  AutocompleteRequestSchema,
  type AutocompleteRequest,
  type AutocompleteResult,
  type EditorDiagnostic,
  type RecentBuffer,
  type RecentChange,
  type UserAction,
} from "./schemas.ts";
import { SymbolOutlineProvider, type DocumentSymbolLoader } from "./symbol-outline.ts";

export interface AutocompleteInput {
  document: vscode.TextDocument;
  position: vscode.Position;
  originalContent: string;
  recentChanges: RecentChange[];
  recentBuffers: RecentBuffer[];
  diagnostics: vscode.Diagnostic[];
  userActions: UserAction[];
  canUseContinuationFallback?: () => boolean;
  onIntermediateResults?: (results: AutocompleteResult[]) => void;
  onEditableWindow?: (window: { startLine: number; endLine: number }) => void;
  traceContext?: Context;
  tracer?: Tracer;
}
export interface ApiClientOptions {
  documentSymbolLoader?: DocumentSymbolLoader;
  outlineProviderTimeoutMs?: number;
  outlineProviderRetryBackoffMs?: number;
  retrievalFileLoader?: RetrievalFileLoader;
  openDocumentsProvider?: () => readonly vscode.TextDocument[];
}
interface CompletionResult {
  text: string;
  finishReason: string;
  promptEvalCount?: number;
  evalCount?: number;
}
interface CompletionRequest {
  model: string;
  prompt: string;
  temperature: number;
  repeatPenalty?: number;
  maxTokens: number;
  stop: string[];
  timeoutMs: number;
  onFirstToken?: () => void;
  onNoEditImpossible?: () => void;
  traceContext?: Context;
  tracer?: Tracer;
}
interface CompletionServer {
  getClient(): {
    complete(request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult>;
  };
  waitUntilReady(retry?: boolean): Promise<void>;
  reportSuccess(): void;
  reportFailure(): void;
}

export class ApiClient {
  private readonly outline: SymbolOutlineProvider;
  private readonly cache = new CompletionCache<CompletionResult>();
  private processingCount = 0;
  private readonly processingListeners = new Set<(processing: boolean) => void>();
  onProcessingChange(listener: (processing: boolean) => void): vscode.Disposable {
    this.processingListeners.add(listener);
    return new vscode.Disposable(() => this.processingListeners.delete(listener));
  }
  private setProcessing(delta: number): void {
    const before = this.processingCount > 0;
    this.processingCount += delta;
    const after = this.processingCount > 0;
    if (before !== after)
      for (const listener of this.processingListeners) {
        try {
          listener(after);
        } catch {}
      }
  }
  constructor(
    private readonly server: CompletionServer,
    private readonly options: ApiClientOptions = {},
  ) {
    this.outline = new SymbolOutlineProvider({
      // Keep the provider available for runtime setting changes; the request
      // path gates collection and refresh against the current config value.
      enabled: true,
      ...(options.documentSymbolLoader
        ? { documentSymbolLoader: options.documentSymbolLoader }
        : {}),
      ...(options.outlineProviderTimeoutMs !== undefined
        ? { timeoutMs: options.outlineProviderTimeoutMs }
        : {}),
      ...(options.outlineProviderRetryBackoffMs !== undefined
        ? { retryBackoffMs: options.outlineProviderRetryBackoffMs }
        : {}),
    });
  }
  dispose(): void {
    this.outline.dispose();
    this.cache.clear();
  }
  refreshOutline(document: vscode.TextDocument): Promise<void> {
    return config.outlineSymbols > 0 ? this.outline.refresh(document) : Promise.resolve();
  }
  async getAutocomplete(
    input: AutocompleteInput,
    signal?: AbortSignal,
  ): Promise<AutocompleteResult[] | null> {
    this.setProcessing(1);
    const span = input.tracer?.startSpan(
      "nesweep.api.autocomplete",
      {},
      input.traceContext ?? ROOT_CONTEXT,
    );
    let outcome: "completed" | "error" | "cancelled" = "completed";
    span?.addEvent("api.invoked");
    try {
      const context = span
        ? trace.setSpan(input.traceContext ?? ROOT_CONTEXT, span)
        : input.traceContext;
      const results = await this.completeAutocomplete(input, signal, context, (name, details) =>
        span?.addEvent(name, details),
      );
      outcome = signal?.aborted ? "cancelled" : "completed";
      span?.setAttribute(
        "nesweep.outcome",
        signal?.aborted ? "cancelled" : results?.length ? "edits" : "no_edit",
      );
      return results;
    } catch {
      outcome = signal?.aborted ? "cancelled" : "error";
      span?.setAttribute("nesweep.outcome", outcome);
      span?.addEvent("api.failed", { outcome: signal?.aborted ? "aborted" : "error" });
      return null;
    } finally {
      if (span) {
        if (outcome !== "completed") span.setAttribute("nesweep.outcome", outcome);
        if (outcome === "error") span.setStatus({ code: SpanStatusCode.ERROR });
        else if (outcome === "completed") span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      }
      this.setProcessing(-1);
    }
  }
  private async completeAutocomplete(
    input: AutocompleteInput,
    signal?: AbortSignal,
    traceContext?: Context,
    phase: (name: string, details?: Record<string, string | number | boolean>) => void = () => {},
  ): Promise<AutocompleteResult[] | null> {
    const { document, position } = input;
    const text = document.getText();
    const version = document.version;
    const requestId = randomUUID();
    if (signal?.aborted || isFileTooLarge(text) || isFileTooLarge(input.originalContent))
      return null;
    const path = toUnixPath(document.uri.fsPath) || "untitled";
    const diagnostics = this.diagnostics(document, input.diagnostics, position);
    const route =
      classifyCompletionRoute(input) === "fim-first" &&
      input.canUseContinuationFallback?.() === true
        ? "fim-first"
        : "zeta-first";
    phase("api.route", { route });
    const model = MODEL_NAME;
    const temperature = TEMPERATURE;
    const maxTokens = MAX_TOKENS;
    // Prompt-dependent cache lookup is completed after prompt preparation.
    let key = "";
    let result: CompletionResult | undefined;
    let continuation: AutocompleteResult[] | null = null;
    const continuationAbort = new AbortController();
    let active = true;
    let impossible = false;
    let firstToken = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let continuationWork: Promise<void> | undefined;
    const cancelContinuation = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (!continuationAbort.signal.aborted) continuationAbort.abort();
    };
    const close = () => {
      active = false;
      cancelContinuation();
      signal?.removeEventListener("abort", cancelContinuation);
    };
    signal?.addEventListener("abort", cancelContinuation, { once: true });
    const timeoutMs = config.completionTimeoutMs;
    let deadline = Number.POSITIVE_INFINITY;
    const snapshotCurrent = () =>
      !signal?.aborted && document.version === version && document.getText() === text;
    const eligible = () =>
      active &&
      snapshotCurrent() &&
      !impossible &&
      typeof input.canUseContinuationFallback === "function" &&
      input.canUseContinuationFallback();
    const runContinuation = () => {
      if (continuationWork || !eligible()) return continuationWork;
      const cursorOffset = document.offsetAt(position);
      const continuationTimeout = Math.min(3_000, deadline - Date.now());
      if (continuationTimeout <= 0) return undefined;
      phase("api.continuation_start");
      const completionWork = this.server.getClient().complete(
        {
          model: CONTINUATION_MODEL_NAME,
          prompt: buildContinuationPrompt(text, cursorOffset),
          temperature: TEMPERATURE,
          repeatPenalty: 1.1,
          maxTokens: 192,
          stop: CONTINUATION_STOP_TOKENS,
          timeoutMs: continuationTimeout,
          ...(traceContext ? { traceContext } : {}),
          ...(input.tracer ? { tracer: input.tracer } : {}),
        },
        continuationAbort.signal,
      );
      continuationWork = completionWork
        .then((completion) => {
          phase("api.continuation_final");
          if (!eligible() || Date.now() >= deadline) return;
          const insertion = parseContinuation(completion, text, cursorOffset);
          phase("api.continuation_parse", { outcome: insertion === null ? "no_edit" : "edit" });
          if (!insertion) return;
          continuation = [
            {
              id: `${requestId}-continuation`,
              source: "continuation",
              startIndex: cursorOffset,
              endIndex: cursorOffset,
              completion: insertion,
              confidence: 0.8,
            },
          ];
          if (route === "fim-first") {
            try {
              input.onIntermediateResults?.(continuation);
            } catch {}
          }
        })
        .catch((error: unknown) => {
          phase("api.continuation_failed", {
            outcome: error instanceof Error && error.name === "AbortError" ? "aborted" : "error",
          });
        });
      // Eligibility can change immediately after the transport has accepted
      // the request. Recheck once the request is observably in flight.
      if (!eligible()) cancelContinuation();
      return continuationWork;
    };
    const startContinuation = () => {
      if (firstToken || impossible || continuationWork || !eligible()) return;
      firstToken = true;
      phase("api.continuation_scheduled", { delayMs: 80 });
      timer = setTimeout(() => {
        timer = undefined;
        void runContinuation();
      }, 80);
    };

    // FIM-first is intentionally allowed to produce a fast insertion before
    // the optional, more expensive Zeta prompt context is gathered.
    let serverReady = false;
    if (route === "fim-first" && !result && eligible()) {
      try {
        await this.server.waitUntilReady();
        serverReady = true;
        phase("api.ready");
        deadline = Date.now() + timeoutMs;
      } catch {
        serverReady = false;
      }
    }
    if (route === "fim-first" && !result && eligible() && serverReady) {
      await runContinuation();
      if (!eligible() || Date.now() >= deadline) {
        close();
        return null;
      }
    }

    const [retrieval, rules] = await Promise.all([
      buildRetrievalChunks({
        document,
        position,
        currentFilePath: path,
        includeClipboard: config.includeClipboardContext,
        ...(this.options.retrievalFileLoader
          ? { retrievalFileLoader: this.options.retrievalFileLoader }
          : {}),
        ...(this.options.openDocumentsProvider
          ? { openDocumentsProvider: this.options.openDocumentsProvider }
          : {}),
      }),
      loadWorkspaceRules(document, { maxWarningCharacters: config.rulesMaxChars }),
    ]);
    if (signal?.aborted || (route === "fim-first" && !snapshotCurrent())) {
      close();
      return null;
    }
    phase("api.build_request");
    const request: AutocompleteRequest = {
      debug_info: this.getDebugInfo(),
      repo_name: vscode.workspace.getWorkspaceFolder(document.uri)?.name || "untitled",
      file_path: path,
      file_contents: text,
      original_file_contents: input.originalContent,
      cursor_position: utf8ByteOffsetAt(document, position),
      recent_changes: formatRecentChanges(input.recentChanges, {
        maxCharacters: config.maxRecentChangesChars,
      }),
      changes_above_cursor: true,
      multiple_suggestions: true,
      file_chunks: buildRecentBufferChunks(input.recentBuffers),
      retrieval_chunks: retrieval,
      symbol_outline:
        config.outlineSymbols > 0
          ? this.outline.getOutline(document, position, config.outlineSymbols)
          : "",
      editor_diagnostics: diagnostics,
      recent_user_actions: input.userActions,
      use_bytes: true,
    };
    // Symbol refresh itself is asynchronous and remains nonblocking. Yielding
    // once lets the provider request start before the primary RPC is issued.
    if (config.outlineSymbols > 0) await Promise.resolve();
    const validated = AutocompleteRequestSchema.safeParse(request);
    if (!validated.success) {
      close();
      return null;
    }
    const commentPrefix = getCommentPrefix(document.languageId);
    const prompt = buildZetaPrompt(validated.data, {
      workspaceRules: rules,
      diagnosticRadius: config.diagRadius,
      inlineDiagnostics: config.injectInlineDiagnostics,
      diagnosticMarker: config.inlineDiagnosticsMarker,
      ...(commentPrefix ? { commentPrefix } : {}),
      diagnosticMessageTransforms: config.diagnosticsMessageTransforms,
      editableTokenBudget: config.editableTokens,
      contextTokenBudget: config.zetaContextTokens,
    });
    if (!prompt || signal?.aborted) {
      close();
      return null;
    }
    phase("api.prompt_built");
    if (deadline === Number.POSITIVE_INFINITY) deadline = Date.now() + timeoutMs;
    try {
      input.onEditableWindow?.({ startLine: prompt.startLine, endLine: prompt.endLine });
    } catch {}
    key = CompletionCache.key(model, prompt.prompt, temperature, maxTokens, prompt.stopTokens);
    if (config.reuseIdenticalPromptResults) result = this.cache.get(key);
    if (result) phase("api.cache_hit");
    try {
      if (!result) {
        if (!serverReady) {
          await this.server.waitUntilReady();
          phase("api.ready");
          serverReady = true;
          if (route === "zeta-first") deadline = Date.now() + timeoutMs;
        }
        if (signal?.aborted) {
          close();
          return null;
        }
        if (Date.now() < deadline) {
          if (route === "zeta-first") {
            phase("api.grpc_start");
            result = await this.server.getClient().complete(
              {
                model,
                prompt: prompt.prompt,
                temperature,
                maxTokens,
                stop: prompt.stopTokens,
                timeoutMs: Math.max(1, deadline - Date.now()),
                onFirstToken: () => {
                  phase("api.grpc_first_token");
                  startContinuation();
                },
                onNoEditImpossible: () => {
                  impossible = true;
                  cancelContinuation();
                },
                ...(traceContext ? { traceContext } : {}),
                ...(input.tracer ? { tracer: input.tracer } : {}),
              },
              signal,
            );
          } else {
            phase("api.grpc_start");
            result = await this.server.getClient().complete(
              {
                model,
                prompt: prompt.prompt,
                temperature,
                maxTokens,
                stop: prompt.stopTokens,
                timeoutMs: Math.max(1, deadline - Date.now()),
                ...(traceContext ? { traceContext } : {}),
                ...(input.tracer ? { tracer: input.tracer } : {}),
              },
              signal,
            );
          }
          if (result) phase("api.grpc_final");
        }
        if (result && config.reuseIdenticalPromptResults && !signal?.aborted)
          this.cache.set(key, result, Date.now(), config.identicalPromptCacheTtlMs);
        if (result) this.server.reportSuccess();
      }
    } catch {
      const availableContinuation =
        continuation && eligible() && Date.now() < deadline ? continuation : null;
      if (!signal?.aborted) this.server.reportFailure();
      phase("api.failed", { outcome: signal?.aborted ? "aborted" : "error" });
      close();
      if (route === "zeta-first") throw new Error("Primary completion failed");
      return availableContinuation;
    }
    if (signal?.aborted || (route === "fim-first" && !snapshotCurrent())) {
      close();
      return null;
    }
    if (!result) {
      const availableContinuation =
        continuation && eligible() && Date.now() < deadline ? continuation : null;
      close();
      return availableContinuation;
    }
    const parsedEdit = parseZetaResponse(
      {
        autocomplete_id: requestId,
        start_index: 0,
        end_index: 0,
        completion: result.text,
        confidence: 1,
        finish_reason: result.finishReason,
      },
      prompt,
    );
    const edit = parsedEdit
      ? normalizeZetaEditAtCursor(parsedEdit, text, document.offsetAt(position))
      : null;
    const noEdit = isZetaNoEditResponse(result, prompt);
    phase("api.response_parse", {
      outcome: edit ? "edits" : noEdit ? "primary_no_edit" : "no_edit",
      resultCount: edit ? 1 : 0,
    });
    if (route === "fim-first" && continuation && (!eligible() || Date.now() >= deadline)) {
      close();
      return null;
    }
    if (!edit && noEdit) {
      if (route === "zeta-first" && !continuationWork && eligible()) {
        if (timer) clearTimeout(timer);
        timer = undefined;
        void runContinuation();
      }
      if (continuationWork) await continuationWork;
    }
    if (
      signal?.aborted ||
      (route === "fim-first" && (!snapshotCurrent() || (continuation !== null && !eligible())))
    ) {
      close();
      return null;
    }
    if (!edit && route === "zeta-first" && !noEdit) {
      close();
      return null;
    }
    const availableContinuation =
      continuation &&
      !impossible &&
      snapshotCurrent() &&
      input.canUseContinuationFallback?.() === true &&
      Date.now() < deadline
        ? continuation
        : null;
    close();
    if (
      edit &&
      (route === "zeta-first" ||
        !continuation ||
        isMeaningfulZetaUpgrade([edit], continuation, text))
    )
      return [edit];
    return availableContinuation;
  }
  private diagnostics(
    document: vscode.TextDocument,
    values: vscode.Diagnostic[],
    position: vscode.Position,
  ): EditorDiagnostic[] {
    const hasCursorError = values.some(
      (d) => d.severity === vscode.DiagnosticSeverity.Error && d.range.start.line === position.line,
    );
    return values
      .filter((d) => !hasCursorError || d.range.start.line <= position.line)
      .slice(0, 15)
      .map((d) => ({
        line: d.range.start.line + 1,
        start_offset: utf8ByteOffsetAt(document, d.range.start),
        end_offset: utf8ByteOffsetAt(document, d.range.end),
        severity:
          ["error", "warning", "info", "hint"][
            d.severity ?? vscode.DiagnosticSeverity.Information
          ] ?? "info",
        message: d.message,
        ...(d.code === undefined
          ? {}
          : { code: String(typeof d.code === "object" ? d.code.value : d.code) }),
        timestamp: Date.now(),
      }));
  }
  getDebugInfo(): string {
    return `VSCode (${vscode.version}) - OS: ${os.platform()} ${os.arch()}`;
  }
}

/** Keep unchanged text around the cursor in the document instead of replacing it. */
function normalizeZetaEditAtCursor(
  result: AutocompleteResult,
  documentText: string,
  cursorOffset: number,
): AutocompleteResult {
  if (
    !Number.isInteger(result.startIndex) ||
    !Number.isInteger(result.endIndex) ||
    result.startIndex < 0 ||
    result.endIndex < result.startIndex ||
    result.endIndex > documentText.length ||
    cursorOffset < result.startIndex ||
    cursorOffset > result.endIndex
  )
    return result;

  const resultWithoutCursorTarget = { ...result };
  delete resultWithoutCursorTarget.cursorTargetOffset;
  let startIndex = result.startIndex;
  let endIndex = result.endIndex;
  let completion = result.completion;
  let cursorTargetOffset = result.cursorTargetOffset;

  const unchangedPrefix = documentText.slice(startIndex, cursorOffset);
  if (unchangedPrefix && completion.startsWith(unchangedPrefix)) {
    startIndex = cursorOffset;
    completion = completion.slice(unchangedPrefix.length);
    if (cursorTargetOffset !== undefined) {
      cursorTargetOffset =
        cursorTargetOffset >= unchangedPrefix.length
          ? cursorTargetOffset - unchangedPrefix.length
          : undefined;
    }
  }

  const unchangedSuffix = documentText.slice(cursorOffset, endIndex);
  if (unchangedSuffix && completion.endsWith(unchangedSuffix)) {
    endIndex = cursorOffset;
    completion = completion.slice(0, -unchangedSuffix.length);
    if (cursorTargetOffset !== undefined && cursorTargetOffset > completion.length)
      cursorTargetOffset = undefined;
  }

  return {
    ...resultWithoutCursorTarget,
    startIndex,
    endIndex,
    completion,
    ...(cursorTargetOffset === undefined ? {} : { cursorTargetOffset }),
  };
}
