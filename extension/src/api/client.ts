import * as os from "node:os";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Context, Tracer } from "@opentelemetry/api";
import {
  MODEL_NAME,
  CONTINUATION_MODEL_NAME,
  CONTINUATION_MAX_TOKENS,
  CONTINUATION_REPEAT_PENALTY,
  CONTINUATION_MAX_TIMEOUT_MS,
  MAX_TOKENS,
  TEMPERATURE,
} from "~/core/constants.ts";
import {
  buildContinuationPrompt,
  parseContinuation,
  isZetaNoEditResponse,
  CONTINUATION_STOP_TOKENS,
} from "./continuation.ts";
import { config } from "~/core/config.ts";
import { normalizePathSeparators } from "~/utils/path.ts";
import { diagnosticSeverityLabel } from "~/utils/diagnostics.ts";
import { isFileTooLarge, utf8ByteOffsetAt } from "~/utils/text.ts";
import { CompletionCache, type CompletionCacheKey } from "./completion-cache.ts";
import { formatRecentChanges } from "./history.ts";
import { parseZetaResponse } from "./parser.ts";
import { classifyCompletionRoute, isMeaningfulZetaUpgrade } from "./completion-routing.ts";
import { buildZetaPrompt } from "./prompt.ts";
import {
  buildRecentBufferChunks,
  buildRetrievalChunks,
  type RetrievalFileLoader,
} from "./retrieval-chunks.ts";
import { getCommentPrefix } from "~/utils/comments.ts";
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

export type AutocompleteInput = {
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
};
export type ApiClientOptions = {
  documentSymbolLoader?: DocumentSymbolLoader;
  outlineProviderTimeoutMs?: number;
  outlineProviderRetryBackoffMs?: number;
  retrievalFileLoader?: RetrievalFileLoader;
  openDocumentsProvider?: () => readonly vscode.TextDocument[];
};
type CompletionResult = {
  text: string;
  finishReason: string;
  promptEvalCount?: number;
  evalCount?: number;
};
type CompletionRequest = {
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
};
type CompletionServer = {
  getClient(): {
    complete(request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult>;
  };
  waitUntilReady(retry?: boolean): Promise<void>;
  reportSuccess(): void;
  reportFailure(): void;
};
type CompletionRoute = "fim-first" | "zeta-first";
type ApiPhase = (name: string, details?: Record<string, string | number | boolean>) => void;
type PreparedPrompt = NonNullable<ReturnType<typeof buildZetaPrompt>>;

type ContinuationSession = {
  startAfterFirstToken(): void;
  run(): Promise<void> | undefined;
  runImmediately(): Promise<void> | undefined;
  close(): void;
  eligible(): boolean;
  available(): AutocompleteResult[] | null;
  markImpossible(): void;
  readonly results: AutocompleteResult[] | null;
  readonly work: Promise<void> | undefined;
};

function createContinuationSession(args: {
  input: AutocompleteInput;
  document: vscode.TextDocument;
  position: vscode.Position;
  text: string;
  version: number;
  requestId: string;
  route: CompletionRoute;
  signal: AbortSignal | undefined;
  traceContext: Context | undefined;
  deadline: () => number;
  complete: (
    this: void,
    request: CompletionRequest,
    signal?: AbortSignal,
  ) => Promise<CompletionResult>;
  phase: ApiPhase;
}): ContinuationSession {
  const {
    input,
    document,
    position,
    text,
    version,
    requestId,
    route,
    signal,
    traceContext,
    deadline,
    complete,
    phase,
  } = args;
  const abort = new AbortController();
  let active = true;
  let impossible = false;
  let firstToken = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let work: Promise<void> | undefined;
  let results: AutocompleteResult[] | null = null;

  const snapshotCurrent = () =>
    !signal?.aborted && document.version === version && document.getText() === text;
  const eligible = () =>
    active &&
    snapshotCurrent() &&
    !impossible &&
    typeof input.canUseContinuationFallback === "function" &&
    input.canUseContinuationFallback();
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!abort.signal.aborted) abort.abort();
  };
  const close = () => {
    active = false;
    cancel();
    signal?.removeEventListener("abort", cancel);
  };
  const run = () => {
    if (work || !eligible()) return work;
    const cursorOffset = document.offsetAt(position);
    const timeoutMs = Math.min(CONTINUATION_MAX_TIMEOUT_MS, deadline() - Date.now());
    if (timeoutMs <= 0) return undefined;
    phase("api.continuation_start");
    const completionWork = complete(
      {
        model: CONTINUATION_MODEL_NAME,
        prompt: buildContinuationPrompt(text, cursorOffset),
        temperature: TEMPERATURE,
        repeatPenalty: CONTINUATION_REPEAT_PENALTY,
        maxTokens: CONTINUATION_MAX_TOKENS,
        stop: CONTINUATION_STOP_TOKENS,
        timeoutMs,
        ...(traceContext ? { traceContext } : {}),
        ...(input.tracer ? { tracer: input.tracer } : {}),
      },
      abort.signal,
    );
    work = completionWork
      .then((completion) => {
        phase("api.continuation_final");
        if (!eligible() || Date.now() >= deadline()) return;
        const insertion = parseContinuation(completion, text, cursorOffset);
        phase("api.continuation_parse", { outcome: insertion === null ? "no_edit" : "edit" });
        if (!insertion) return;
        results = [
          {
            id: `${requestId}-continuation`,
            source: "continuation",
            startIndex: cursorOffset,
            endIndex: cursorOffset,
            completion: insertion,
          },
        ];
        if (route === "fim-first") {
          try {
            input.onIntermediateResults?.(results);
          } catch {}
        }
      })
      .catch((error: unknown) => {
        phase("api.continuation_failed", {
          outcome: error instanceof Error && error.name === "AbortError" ? "aborted" : "error",
        });
      });
    // Recheck after dispatch so a stale request cannot keep fallback work alive.
    if (!eligible()) cancel();
    return work;
  };
  const startAfterFirstToken = () => {
    if (firstToken || impossible || work || !eligible()) return;
    firstToken = true;
    phase("api.continuation_scheduled", { delayMs: 80 });
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, 80);
  };

  signal?.addEventListener("abort", cancel, { once: true });
  return {
    startAfterFirstToken,
    run,
    runImmediately: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      return run();
    },
    close,
    eligible,
    available: () =>
      results &&
      !impossible &&
      snapshotCurrent() &&
      input.canUseContinuationFallback?.() === true &&
      Date.now() < deadline()
        ? results
        : null,
    markImpossible: () => {
      impossible = true;
      cancel();
    },
    get results() {
      return results;
    },
    get work() {
      return work;
    },
  };
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
    phase: ApiPhase = () => {},
  ): Promise<AutocompleteResult[] | null> {
    const { document, position } = input;
    const text = document.getText();
    const version = document.version;
    const requestId = randomUUID();
    if (signal?.aborted || isFileTooLarge(text) || isFileTooLarge(input.originalContent))
      return null;

    const path = normalizePathSeparators(document.uri.fsPath) || "untitled";
    const diagnostics = this.diagnostics(document, input.diagnostics, position);
    const route: CompletionRoute =
      classifyCompletionRoute(input) === "fim-first" &&
      input.canUseContinuationFallback?.() === true
        ? "fim-first"
        : "zeta-first";
    phase("api.route", { route });
    const model = MODEL_NAME;
    const temperature = TEMPERATURE;
    const maxTokens = MAX_TOKENS;
    const timeoutMs = config.completionTimeoutMs;
    let deadline = Number.POSITIVE_INFINITY;
    let serverReady = false;
    let result: CompletionResult | undefined;
    const continuation = createContinuationSession({
      input,
      document,
      position,
      text,
      version,
      requestId,
      route,
      signal,
      traceContext,
      deadline: () => deadline,
      complete: (request, abortSignal) => this.server.getClient().complete(request, abortSignal),
      phase,
    });

    // Publish the fast FIM insertion before doing optional prompt-context work.
    if (route === "fim-first" && continuation.eligible()) {
      try {
        await this.server.waitUntilReady();
        serverReady = true;
        phase("api.ready");
        deadline = Date.now() + timeoutMs;
      } catch {
        serverReady = false;
      }
    }
    if (route === "fim-first" && continuation.eligible() && serverReady) {
      await continuation.run();
      if (!continuation.eligible() || Date.now() >= deadline) {
        continuation.close();
        return null;
      }
    }

    const prompt = await this.preparePrompt(
      input,
      text,
      version,
      path,
      diagnostics,
      route,
      signal,
      phase,
    );
    if (!prompt) {
      continuation.close();
      return null;
    }
    phase("api.prompt_built");
    if (deadline === Number.POSITIVE_INFINITY) deadline = Date.now() + timeoutMs;
    try {
      input.onEditableWindow?.({ startLine: prompt.startLine, endLine: prompt.endLine });
    } catch {}

    const key: CompletionCacheKey = {
      model,
      prompt: prompt.prompt,
      temperature,
      maxTokens,
      stop: prompt.stopTokens,
    };
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
          continuation.close();
          return null;
        }
        if (Date.now() < deadline) {
          phase("api.grpc_start");
          result = await this.server.getClient().complete(
            {
              model,
              prompt: prompt.prompt,
              temperature,
              maxTokens,
              stop: prompt.stopTokens,
              timeoutMs: Math.max(1, deadline - Date.now()),
              ...(route === "zeta-first"
                ? {
                    onFirstToken: () => {
                      phase("api.grpc_first_token");
                      continuation.startAfterFirstToken();
                    },
                    onNoEditImpossible: () => continuation.markImpossible(),
                  }
                : {}),
              ...(traceContext ? { traceContext } : {}),
              ...(input.tracer ? { tracer: input.tracer } : {}),
            },
            signal,
          );
          if (result) phase("api.grpc_final");
        }
        if (result && config.reuseIdenticalPromptResults && !signal?.aborted)
          this.cache.set(key, result, Date.now(), config.identicalPromptCacheTtlMs);
        if (result) this.server.reportSuccess();
      }
    } catch {
      const availableContinuation =
        continuation.results && continuation.eligible() && Date.now() < deadline
          ? continuation.results
          : null;
      if (!signal?.aborted) this.server.reportFailure();
      phase("api.failed", { outcome: signal?.aborted ? "aborted" : "error" });
      continuation.close();
      if (route === "zeta-first") throw new Error("Primary completion failed");
      return availableContinuation;
    }

    const snapshotCurrent = () =>
      !signal?.aborted && document.version === version && document.getText() === text;
    if (signal?.aborted || (route === "fim-first" && !snapshotCurrent())) {
      continuation.close();
      return null;
    }
    if (!result) {
      const availableContinuation =
        continuation.results && continuation.eligible() && Date.now() < deadline
          ? continuation.results
          : null;
      continuation.close();
      return availableContinuation;
    }

    const parsedEdit = parseZetaResponse(
      {
        autocomplete_id: requestId,
        start_index: 0,
        end_index: 0,
        completion: result.text,
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

    if (
      route === "fim-first" &&
      continuation.results &&
      (!continuation.eligible() || Date.now() >= deadline)
    ) {
      continuation.close();
      return null;
    }
    if (!edit && noEdit) {
      if (route === "zeta-first" && !continuation.work && continuation.eligible())
        void continuation.runImmediately();
      if (continuation.work) await continuation.work;
    }
    if (
      signal?.aborted ||
      (route === "fim-first" &&
        (!snapshotCurrent() || (continuation.results !== null && !continuation.eligible())))
    ) {
      continuation.close();
      return null;
    }
    if (!edit && route === "zeta-first" && !noEdit) {
      continuation.close();
      return null;
    }

    const availableContinuation = continuation.available();
    continuation.close();
    if (
      edit &&
      (route === "zeta-first" ||
        !continuation.results ||
        isMeaningfulZetaUpgrade([edit], continuation.results, text))
    )
      return [edit];
    return availableContinuation;
  }

  private async preparePrompt(
    input: AutocompleteInput,
    text: string,
    version: number,
    path: string,
    diagnostics: EditorDiagnostic[],
    route: CompletionRoute,
    signal: AbortSignal | undefined,
    phase: ApiPhase,
  ): Promise<PreparedPrompt | null> {
    const { document, position } = input;
    const retrieval = await buildRetrievalChunks({
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
    });
    if (
      signal?.aborted ||
      (route === "fim-first" && (document.version !== version || document.getText() !== text))
    )
      return null;

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
    // Start the asynchronous symbol refresh before dispatching the primary RPC.
    if (config.outlineSymbols > 0) await Promise.resolve();
    const validated = AutocompleteRequestSchema.safeParse(request);
    if (!validated.success) return null;

    const commentPrefix = getCommentPrefix(document.languageId);
    const prompt = buildZetaPrompt(validated.data, {
      diagnosticRadius: config.diagRadius,
      inlineDiagnostics: config.injectInlineDiagnostics,
      diagnosticMarker: config.inlineDiagnosticsMarker,
      ...(commentPrefix ? { commentPrefix } : {}),
      diagnosticMessageTransforms: config.diagnosticsMessageTransforms,
      editableTokenBudget: config.editableTokens,
      contextTokenBudget: config.zetaContextTokens,
    });
    return !prompt || signal?.aborted ? null : prompt;
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
        severity: diagnosticSeverityLabel(d.severity),
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
