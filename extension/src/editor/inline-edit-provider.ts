import * as vscode from "vscode";
import { ROOT_CONTEXT, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import type { ApiClient, AutocompleteInput } from "~/api/client.ts";
import type { AutocompleteResult } from "~/api/schemas.ts";
import { config } from "~/core/config";
import {
  BULK_CHANGE_CHAR_THRESHOLD,
  BULK_CHANGE_LINE_THRESHOLD,
  BULK_CHANGE_LOOKBACK_MS,
  INLINE_REQUEST_DEBOUNCE_MS,
  MAX_FILE_CHUNK_LINES,
  SELECTION_LOOKBACK_MS,
} from "~/core/constants.ts";
import { isMeaningfulZetaUpgrade } from "~/api/completion-routing.ts";
import { enableForwardStability, markAsProposedInlineEdit } from "~/editor/proposed-inline-edit.ts";
import { splitEditIntoSegments } from "~/editor/split-edit-segments.ts";
import type { JumpEditManager } from "~/editor/jump-edit-manager.ts";
import {
  type AutocompleteMetricsPayload,
  AutocompleteMetricsTracker,
  buildMetricsPayload,
} from "~/telemetry/autocomplete-metrics.ts";
import type { DocumentTracker } from "~/telemetry/document-tracker.ts";
import type { ExtensionTelemetry } from "~/core/telemetry.ts";
import { normalizePathSeparators } from "~/utils/path.ts";
import { isFileTooLarge, utf8ByteOffsetAt } from "~/utils/text.ts";

type QueuedSuggestionState = {
  uri: string;
  suggestions: AutocompleteResult[];
};

type AcceptedInlineSuggestion = {
  id: string;
  uri?: string;
  startIndex: number;
  endIndex: number;
  completion: string;
  cursorTargetOffset?: number;
};

type RequestSnapshot = {
  uri: string;
  version: number;
  position: vscode.Position;
  content: string;
};

type FimSession = {
  requestId: number;
  snapshot: RequestSnapshot;
  token: vscode.CancellationToken;
  fim: AutocompleteResult[] | null;
  shownItem: vscode.InlineCompletionItem | null;
  upgrade: AutocompleteResult[] | null;
  refreshing: boolean;
};

type InFlightRequest = {
  id: number;
  controller: AbortController;
  uri: string;
  snapshot: RequestSnapshot;
  response?: Promise<AutocompleteResult[] | null>;
};

type EditableWindowState = RequestSnapshot & {
  startLine: number;
  endLine: number;
  triggered: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

export class InlineEditProvider implements vscode.InlineCompletionItemProvider {
  private tracker: DocumentTracker;
  private jumpEditManager: JumpEditManager;
  private api: ApiClient;
  private metricsTracker: AutocompleteMetricsTracker;
  private telemetry: ExtensionTelemetry | undefined;
  private readonly completionSpans = new Set<Span>();
  private disposed = false;
  private lastInlineEdit: {
    uri: string;
    line: number;
    character: number;
    version: number;
    payload: AutocompleteMetricsPayload;
    id: string;
    insertion: string | null;
    content: string;
  } | null = null;
  private queuedSuggestions: QueuedSuggestionState | null = null;
  private shouldConsumeQueuedSuggestion = false;
  private requestCounter = 0;
  private latestRequestId = 0;
  private inFlightRequest: InFlightRequest | null = null;
  private fimSession: FimSession | null = null;
  private editableWindow: EditableWindowState | null = null;
  private lastRequestTimestamp = 0;
  private proposedNavigation: {
    document: vscode.TextDocument;
    uri: string;
    version: number;
    line: number;
    scheduled: boolean;
  } | null = null;

  constructor(
    tracker: DocumentTracker,
    jumpEditManager: JumpEditManager,
    api: ApiClient,
    metricsTracker?: AutocompleteMetricsTracker | ExtensionTelemetry,
    telemetry?: ExtensionTelemetry,
  ) {
    this.tracker = tracker;
    this.jumpEditManager = jumpEditManager;
    this.api = api;
    this.metricsTracker =
      metricsTracker && "trackShown" in metricsTracker
        ? metricsTracker
        : new AutocompleteMetricsTracker();
    this.telemetry =
      telemetry ??
      (metricsTracker && "startCompletion" in metricsTracker ? metricsTracker : undefined);
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionList | undefined> {
    if (this.disposed) return undefined;
    let completionSpan: Span | undefined;
    let completionOutcome = "no_edit";
    let buildingInput = false;
    const previousSession = this.fimSession;
    const queuedUpgrade =
      previousSession?.refreshing &&
      previousSession.upgrade &&
      this.isRequestContextCurrent(previousSession.snapshot, previousSession.token)
        ? previousSession.upgrade
        : null;
    this.fimSession = null;
    const requestId = ++this.requestCounter;
    this.latestRequestId = requestId;
    const uri = document.uri.toString();
    const requestSnapshot: RequestSnapshot = {
      uri,
      version: document.version,
      position,
      content: document.getText(),
    };
    const reusableRequest = this.getReusableInFlightRequest(requestSnapshot, document);
    if (!reusableRequest) this.cancelInFlightRequest("superseded by new request");

    if (!config.enabled) {
      this.cancelInFlightRequest("autocomplete disabled");
      this.fimSession = null;
      this.clearEditableWindow("autocomplete disabled");
      return undefined;
    }
    if (config.isAutocompleteSnoozed()) {
      this.cancelInFlightRequest("autocomplete snoozed");
      this.fimSession = null;
      this.clearEditableWindow("autocomplete snoozed");
      return undefined;
    }

    const suppressionReason = await this.getSuppressionReason(document);
    if (suppressionReason) {
      console.log("[Sweep] Suppressing inline edit:", suppressionReason);
      return undefined;
    }

    const filePath = document.uri.fsPath;
    if (filePath && config.shouldExcludeFromAutocomplete(filePath)) {
      return undefined;
    }
    const currentContent = requestSnapshot.content;
    if (
      reusableRequest &&
      previousSession &&
      this.isRequestContextCurrent(previousSession.snapshot, previousSession.token)
    ) {
      previousSession.requestId = requestId;
      this.fimSession = previousSession;
    }
    if (!reusableRequest) {
      this.cancelInFlightRequest("superseded by new request");
    }
    const originalContent = this.tracker.getOriginalContent(uri) ?? currentContent;

    if (isFileTooLarge(currentContent) || isFileTooLarge(originalContent)) {
      console.log("[Sweep] Skipping inline edit: file too large", {
        uri,
        currentLength: currentContent.length,
        originalLength: originalContent.length,
      });
      return undefined;
    }

    if (this.shouldConsumeQueuedSuggestion) {
      const queuedItems = this.consumeQueuedSuggestion(document, position);
      if (queuedItems) {
        return queuedItems;
      }
    }

    if (token.isCancellationRequested) return undefined;

    const shouldContinue = await this.waitForDebounce(requestId, token);
    if (!shouldContinue) return undefined;
    if (!this.isLatestRequest(requestId)) return undefined;

    completionSpan = this.telemetry?.startCompletion(document);
    if (completionSpan) this.completionSpans.add(completionSpan);
    const controller = new AbortController();
    const activeController = reusableRequest?.controller ?? controller;
    if (reusableRequest) {
      this.inFlightRequest = { ...reusableRequest, id: requestId };
    } else {
      this.inFlightRequest = { id: requestId, controller, uri, snapshot: requestSnapshot };
    }
    const cancellation = reusableRequest
      ? undefined
      : token.onCancellationRequested(() => controller.abort());

    try {
      let sourceSnapshot = requestSnapshot;
      let responsePromise: Promise<AutocompleteResult[] | null>;
      if (queuedUpgrade) {
        responsePromise = Promise.resolve(queuedUpgrade);
        const request = this.inFlightRequest;
        if (request?.id === requestId) {
          request.response = responsePromise;
          void responsePromise.then(
            () => this.clearInFlightRequest(activeController),
            () => this.clearInFlightRequest(activeController),
          );
        }
      } else if (reusableRequest?.response) {
        sourceSnapshot = reusableRequest.snapshot;
        responsePromise = reusableRequest.response;
      } else {
        const parentContext = completionSpan
          ? trace.setSpan(ROOT_CONTEXT, completionSpan)
          : ROOT_CONTEXT;
        const buildSpan = this.telemetry?.tracer?.startSpan(
          "nesweep.provider.build_input",
          undefined,
          parentContext,
        );
        let input: AutocompleteInput;
        buildingInput = true;
        try {
          input = this.buildInput(document, position, originalContent);
          buildingInput = false;
          buildSpan?.end();
        } catch (error) {
          if (buildSpan) {
            buildSpan.setAttribute("error.type", error instanceof Error ? error.name : "Error");
            buildSpan.setStatus({ code: SpanStatusCode.ERROR });
            buildSpan.end();
          }
          completionOutcome = "error";
          throw error;
        }
        if (completionSpan) input.traceContext = trace.setSpan(ROOT_CONTEXT, completionSpan);
        if (this.telemetry?.tracer) input.tracer = this.telemetry.tracer;
        const session: FimSession = {
          requestId,
          snapshot: requestSnapshot,
          token,
          fim: null,
          shownItem: null,
          upgrade: null,
          refreshing: false,
        };
        this.fimSession = session;
        responsePromise = this.startAutocompleteRequest(input, session, activeController);
      }
      const responseResults = await responsePromise;

      if (
        !config.enabled ||
        token.isCancellationRequested ||
        activeController.signal.aborted ||
        !responseResults?.length
      ) {
        return undefined;
      }

      const isLatestRequest = this.isLatestRequest(requestId);
      const candidates = reusableRequest
        ? this.tryBuildGhostTextExtension(sourceSnapshot, document, responseResults)
        : responseResults;
      if (!candidates?.length) {
        if (reusableRequest) {
          this.cancelInFlightRequest("reused completion did not extend typed identifier");
          this.fimSession = null;
          void vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
        }
        return undefined;
      }
      let results = candidates.flatMap((result) =>
        splitEditIntoSegments(requestSnapshot.content, result),
      );
      if (!isLatestRequest) {
        const extendedResults = this.tryBuildGhostTextExtension(
          requestSnapshot,
          document,
          candidates,
        );
        if (!extendedResults?.length) {
          return undefined;
        }
        results = extendedResults;
      }

      if (this.isRequestStale(requestSnapshot, token)) {
        console.log("[Sweep] Inline edit response stale; skipping render", {
          uri,
          requestVersion: requestSnapshot.version,
          currentVersion: document.version,
          requestLine: requestSnapshot.position.line,
          requestCharacter: requestSnapshot.position.character,
          contentMatches: requestSnapshot.content === document.getText(),
        });
        return undefined;
      }

      const renderSuppressionReason = await this.getSuppressionReason(document);
      if (this.isRequestStale(requestSnapshot, token) || !this.isLatestRequest(requestId))
        return undefined;
      if (renderSuppressionReason) {
        console.log("[Sweep] Suppressing inline edit render:", renderSuppressionReason);
        return undefined;
      }

      const { renderMode, inlineResults, routedResults, jumpResult } =
        this.classifyCompletionResults(document, position, context, results);

      if (renderMode === "JUMP" && jumpResult) {
        const jumpIndex = routedResults.findIndex((result) => result.id === jumpResult?.id);
        const queuedAfterJump = jumpIndex >= 0 ? routedResults.slice(jumpIndex + 1) : [];
        this.setSuggestionQueue(uri, queuedAfterJump);
        const item = this.buildCompletionItem(document, position, jumpResult, true);
        if (item) completionOutcome = "inline_handoff";
        return item;
      }

      if (inlineResults.length === 0) {
        return undefined;
      }
      const firstInlineResult = inlineResults[0];
      if (!firstInlineResult) {
        this.clearSuggestionQueue("missing first inline suggestion");
        return undefined;
      }
      this.setSuggestionQueue(uri, routedResults.slice(1));

      console.log("[Sweep] Rendering inline edit suggestions", {
        count: inlineResults.length,
        cursorLine: position.line,
        firstEditStartLine: document.positionAt(firstInlineResult.startIndex).line,
      });
      const item = this.buildCompletionItem(document, position, firstInlineResult);
      if (item) completionOutcome = "inline_handoff";
      return item;
    } catch (error) {
      completionOutcome = "error";
      if ((error as Error).name === "AbortError") {
        completionOutcome = "cancelled";
        return undefined;
      }
      if (buildingInput) throw error;
      console.error("[Sweep] InlineEditProvider error:", error);
      return undefined;
    } finally {
      cancellation?.dispose();
      if (token.isCancellationRequested && completionOutcome === "no_edit")
        completionOutcome = "cancelled";
      this.endCompletionSpan(completionSpan, completionOutcome);
    }
  }

  private startAutocompleteRequest(
    input: AutocompleteInput,
    session: FimSession,
    activeController: AbortController,
  ): Promise<AutocompleteResult[] | null> {
    // Capture the originating request before session.requestId can be updated by reuse.
    const { requestId, snapshot: requestSnapshot, token } = session;
    input.canUseContinuationFallback = () =>
      config.enabled &&
      this.isLatestRequest(requestId) &&
      (!session.fim || this.fimSession === session) &&
      !this.isRequestStale(requestSnapshot, token);

    let publishIntermediate!: (results: AutocompleteResult[]) => void;
    const intermediate = new Promise<AutocompleteResult[]>((resolve) => {
      publishIntermediate = resolve;
    });
    input.onIntermediateResults = (results) => {
      if (
        this.fimSession !== session ||
        !config.enabled ||
        this.isRequestStale(requestSnapshot, token) ||
        activeController.signal.aborted ||
        session.fim ||
        results.length === 0
      )
        return;
      session.fim = results;
      publishIntermediate(results);
    };
    input.onEditableWindow = ({ startLine, endLine }) => {
      if (
        !config.retriggerOnContextExit ||
        !this.isLatestRequest(requestId) ||
        this.isRequestStale(requestSnapshot, token)
      )
        return;
      this.rememberEditableWindow(requestSnapshot, startLine, endLine);
    };

    const final = this.api.getAutocomplete(input, activeController.signal);
    const request = this.inFlightRequest;
    const responsePromise = Promise.race([intermediate, final]);
    if (request?.id === requestId) request.response = responsePromise;
    void final.then(
      () => this.clearInFlightRequest(activeController),
      () => this.clearInFlightRequest(activeController),
    );
    void final.then(
      (results) => {
        if (
          this.fimSession !== session ||
          !session.fim ||
          !results?.length ||
          !isMeaningfulZetaUpgrade(results, session.fim, requestSnapshot.content)
        )
          return;
        session.upgrade = results;
        this.publishZetaUpgrade(session);
      },
      () => {},
    );
    return responsePromise;
  }

  private classifyCompletionResults(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    results: AutocompleteResult[],
  ) {
    let renderMode: "INLINE" | "JUMP" | null = null;
    const inlineResults: AutocompleteResult[] = [];
    const routedResults: AutocompleteResult[] = [];
    let jumpResult: AutocompleteResult | null = null;

    for (const result of results) {
      const normalizedResult = this.normalizeInlineResult(document, position, result);
      if (!normalizedResult) {
        continue;
      }

      if (this.isNoOpSuggestion(document, normalizedResult)) {
        continue;
      }

      const classification = this.jumpEditManager.classifyEditDisplay(
        document,
        position,
        normalizedResult,
      );
      if (classification.decision === "SUPPRESS") {
        console.log("[Sweep] Suppressing suggestion after display classification", {
          reason: classification.reason,
          id: normalizedResult.id,
        });
        continue;
      }

      if (classification.decision === "INLINE" && context.selectedCompletionInfo) {
        const selected = context.selectedCompletionInfo;
        const range = new vscode.Range(
          document.positionAt(normalizedResult.startIndex),
          document.positionAt(normalizedResult.endIndex),
        );
        if (
          !range.isEqual(selected.range) ||
          !normalizedResult.completion.startsWith(selected.text)
        )
          continue;
      }

      routedResults.push(normalizedResult);

      if (classification.decision === "JUMP") {
        if (!renderMode) {
          renderMode = "JUMP";
          jumpResult = normalizedResult;
        }
        continue;
      }

      if (!renderMode) {
        renderMode = "INLINE";
      }
      if (renderMode === "INLINE") {
        inlineResults.push(normalizedResult);
      }
    }
    return { renderMode, inlineResults, routedResults, jumpResult };
  }

  dispose(): void {
    this.disposed = true;
    this.latestRequestId = ++this.requestCounter;
    this.cancelInFlightRequest("provider disposed");
    for (const span of this.completionSpans) this.endCompletionSpan(span, "disposed");
    this.fimSession = null;
    this.clearEditableWindow("provider disposed");
    this.proposedNavigation = null;
    this.clearInlineEdit("provider disposed");
    this.clearSuggestionQueue();
  }

  private endCompletionSpan(span: Span | undefined, outcome: string): void {
    if (!span || !this.completionSpans.delete(span)) return;
    this.telemetry?.endCompletion(span, outcome);
  }

  private cancelInFlightRequest(reason: string): void {
    if (!this.inFlightRequest) return;
    console.log("[Sweep] Cancelling in-flight inline edit request:", reason);
    this.inFlightRequest.controller.abort();
    this.inFlightRequest = null;
  }

  private clearInFlightRequest(controller: AbortController): void {
    if (this.inFlightRequest?.controller === controller) this.inFlightRequest = null;
  }

  private getReusableInFlightRequest(
    snapshot: RequestSnapshot,
    document: vscode.TextDocument,
  ): InFlightRequest | null {
    const request = this.inFlightRequest;
    if (
      !request?.response ||
      request.controller.signal.aborted ||
      request.uri !== snapshot.uri ||
      request.snapshot.uri !== snapshot.uri ||
      request.snapshot.position.line !== snapshot.position.line ||
      request.snapshot.version === snapshot.version
    )
      return null;

    const cursorOffset = document.offsetAt(request.snapshot.position);
    const inserted = this.extractInsertedTextAtCursor(
      request.snapshot.content,
      snapshot.content,
      cursorOffset,
    );
    if (
      !inserted ||
      !/^[A-Za-z0-9_]+$/.test(inserted) ||
      snapshot.position.line !== request.snapshot.position.line ||
      snapshot.position.character !== request.snapshot.position.character + inserted.length
    )
      return null;
    return request;
  }

  private rememberEditableWindow(
    snapshot: RequestSnapshot,
    startLine: number,
    endLine: number,
  ): void {
    const existing = this.editableWindow;
    if (
      existing?.uri === snapshot.uri &&
      existing.version === snapshot.version &&
      existing.startLine === startLine &&
      existing.endLine === endLine
    )
      return;
    this.clearEditableWindow("new editable window");
    this.editableWindow = {
      ...snapshot,
      startLine,
      endLine,
      triggered: false,
    };
  }

  private clearEditableWindow(_reason: string): void {
    if (this.editableWindow?.timer) clearTimeout(this.editableWindow.timer);
    this.editableWindow = null;
  }

  private updateContextExitRefresh(document: vscode.TextDocument, position: vscode.Position): void {
    const window = this.editableWindow;
    if (!config.retriggerOnContextExit) {
      this.clearEditableWindow("disabled");
      return;
    }
    if (
      !window ||
      window.uri !== document.uri.toString() ||
      window.version !== document.version ||
      window.content !== document.getText()
    ) {
      this.clearEditableWindow("document context changed");
      return;
    }

    const span = Math.max(0, window.endLine - window.startLine);
    const threshold = Math.max(1, Math.ceil(span / 2));
    const distance =
      position.line < window.startLine
        ? window.startLine - position.line
        : position.line >= window.endLine
          ? position.line - window.endLine + 1
          : 0;
    if (distance === 0) {
      if (window.timer) clearTimeout(window.timer);
      delete window.timer;
      return;
    }
    if (distance < threshold || window.triggered || window.timer) return;

    window.timer = setTimeout(() => {
      delete window.timer;
      const editor = vscode.window.activeTextEditor;
      if (
        this.editableWindow !== window ||
        !config.retriggerOnContextExit ||
        editor?.document.uri.toString() !== window.uri ||
        editor.document.version !== window.version ||
        editor.document.getText() !== window.content
      )
        return;
      const activePosition = editor.selection.active;
      const activeDistance =
        activePosition.line < window.startLine
          ? window.startLine - activePosition.line
          : activePosition.line >= window.endLine
            ? activePosition.line - window.endLine + 1
            : 0;
      if (activeDistance < threshold) return;
      window.triggered = true;
      void vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
    }, config.contextExitRetriggerDebounceMs);
  }

  handleDidShowCompletionItem(item: vscode.InlineCompletionItem): void {
    const session = this.fimSession;
    const args = item.command?.arguments;
    const suggestion = args?.find(
      (argument): argument is AcceptedInlineSuggestion =>
        typeof argument === "object" && argument !== null && "id" in argument,
    );
    if (!session || suggestion?.id !== session.fim?.[0]?.id) return;
    session.shownItem = item;
    this.publishZetaUpgrade(session);
  }

  handleDidRejectCompletionItem(item: vscode.InlineCompletionItem): void {
    if (this.fimSession?.shownItem === item) this.fimSession = null;
  }

  handleEndOfLifetime(item: vscode.InlineCompletionItem): void {
    const session = this.fimSession;
    if (session?.shownItem === item && !session.refreshing) this.fimSession = null;
  }

  private publishZetaUpgrade(session: FimSession): void {
    if (
      this.fimSession !== session ||
      !session.shownItem ||
      !session.upgrade ||
      session.refreshing ||
      !config.enabled ||
      !this.isLatestRequest(session.requestId) ||
      !this.isRequestContextCurrent(session.snapshot, session.token) ||
      this.lastInlineEdit?.id !== session.fim?.[0]?.id
    )
      return;
    session.refreshing = true;
    void vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
  }

  private async getSuppressionReason(document: vscode.TextDocument): Promise<string | null> {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) return "no active editor";
    if (activeEditor.document.uri.toString() !== document.uri.toString()) {
      return "inactive document";
    }
    if (!vscode.window.state.focused) return "window not focused";

    if (
      this.hasMultiLineSelection(activeEditor, document) ||
      this.tracker.wasRecentMultiLineSelection(document.uri.toString(), SELECTION_LOOKBACK_MS)
    ) {
      return "multi-line selection";
    }

    const editorTextFocus = await this.getContextKeyValue<boolean>("editorTextFocus");
    if (editorTextFocus === false) return "editor not focused";

    const isWritable = vscode.workspace.fs.isWritableFileSystem(document.uri.scheme);
    if (isWritable === false) return "read-only document";

    const inSnippetMode = await this.getContextKeyValue<boolean>("inSnippetMode");
    if (inSnippetMode) return "snippet/template mode";

    const uri = document.uri.toString();
    if (
      this.tracker.wasRecentBulkChange(uri, {
        windowMs: BULK_CHANGE_LOOKBACK_MS,
        charThreshold: BULK_CHANGE_CHAR_THRESHOLD,
        lineThreshold: BULK_CHANGE_LINE_THRESHOLD,
      })
    ) {
      return "recent bulk edit";
    }

    return null;
  }

  private async getContextKeyValue<T>(key: string): Promise<T | undefined> {
    try {
      return (await vscode.commands.executeCommand("getContextKeyValue", key)) as T | undefined;
    } catch {
      return undefined;
    }
  }

  private hasMultiLineSelection(editor: vscode.TextEditor, document: vscode.TextDocument): boolean {
    for (const selection of editor.selections) {
      if (selection.isEmpty) continue;
      if (selection.start.line !== selection.end.line) return true;
      const selectedText = document.getText(selection);
      if (selectedText.includes("\n")) return true;
    }
    return false;
  }

  private async waitForDebounce(
    requestId: number,
    token: vscode.CancellationToken,
  ): Promise<boolean> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTimestamp;
    this.lastRequestTimestamp = now;

    const delay = Math.max(0, INLINE_REQUEST_DEBOUNCE_MS - elapsed);
    if (delay === 0) return !token.isCancellationRequested;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        disposable.dispose();
        resolve();
      }, delay);
      const disposable = token.onCancellationRequested(() => {
        clearTimeout(timeout);
        disposable.dispose();
        resolve();
      });
    });
    if (token.isCancellationRequested) return false;
    return this.isLatestRequest(requestId);
  }

  private isLatestRequest(requestId: number): boolean {
    return requestId === this.latestRequestId;
  }

  private buildCompletionItem(
    document: vscode.TextDocument,
    position: vscode.Position,
    result: AutocompleteResult,
    proposed = false,
  ): vscode.InlineCompletionList | undefined {
    const cursorOffset = document.offsetAt(position);
    const startPosition = document.positionAt(result.startIndex);
    const endPosition = document.positionAt(result.endIndex);
    const editRange = new vscode.Range(startPosition, endPosition);

    console.log("[Sweep] Creating inline edit:", {
      id: result.id,
      startPosition: `${startPosition.line}:${startPosition.character}`,
      endPosition: `${endPosition.line}:${endPosition.character}`,
      cursorPosition: `${position.line}:${position.character}`,
      cursorOffset,
      startIndex: result.startIndex,
      endIndex: result.endIndex,
      completionPreview: result.completion.slice(0, 100),
    });

    proposed = proposed || result.startIndex < cursorOffset;

    const metricsPayload = buildMetricsPayload(document, result, {
      suggestionType: "GHOST_TEXT",
    });

    if (this.lastInlineEdit?.payload.id !== metricsPayload.id) {
      this.clearInlineEdit("replaced by new inline edit", {
        hideSuggestion: false,
        preserveQueue: true,
      });
    }

    const acceptedSuggestion: AcceptedInlineSuggestion = {
      id: result.id,
      uri: document.uri.toString(),
      startIndex: result.startIndex,
      endIndex: result.endIndex,
      completion: result.completion,
      ...(proposed && result.cursorTargetOffset !== undefined
        ? { cursorTargetOffset: result.cursorTargetOffset }
        : {}),
    };
    const target = (result as AutocompleteResult & { cursorTargetOffset?: number })
      .cursorTargetOffset;
    let insertText: string | vscode.SnippetString = result.completion;
    if (!proposed && target !== undefined && target >= 0 && target <= result.completion.length) {
      insertText = new vscode.SnippetString()
        .appendText(result.completion.slice(0, target))
        .appendTabstop(0)
        .appendText(result.completion.slice(target));
    }
    const item = new vscode.InlineCompletionItem(insertText, editRange);
    if (proposed) {
      markAsProposedInlineEdit(item, { showRange: editRange, correlationId: result.id });
      this.proposedNavigation = {
        document,
        uri: document.uri.toString(),
        version: document.version,
        line: startPosition.line,
        scheduled: false,
      };
    } else this.proposedNavigation = null;
    item.command = {
      title: "Accept Sweep Inline Edit",
      command: "sweep.acceptInlineEdit",
      arguments: [metricsPayload, acceptedSuggestion],
    };

    this.lastInlineEdit = {
      uri: document.uri.toString(),
      id: result.id,
      line: position.line,
      character: position.character,
      version: document.version,
      payload: metricsPayload,
      insertion:
        result.startIndex === cursorOffset && result.endIndex === cursorOffset
          ? result.completion
          : null,
      content: document.getText(),
    };
    this.metricsTracker.trackShown(metricsPayload);
    const list = { items: [item] };
    return proposed ? enableForwardStability(list) : list;
  }

  async handleCursorMove(document: vscode.TextDocument, position: vscode.Position): Promise<void> {
    this.updateContextExitRefresh(document, position);
    if (
      this.fimSession &&
      !this.isRequestContextCurrent(this.fimSession.snapshot, this.fimSession.token)
    )
      this.fimSession = null;
    if (this.queuedSuggestions && this.queuedSuggestions.uri !== document.uri.toString()) {
      this.clearSuggestionQueue("active document changed");
    }

    const navigation = this.proposedNavigation;
    if (navigation) {
      if (
        navigation.document !== document ||
        navigation.uri !== document.uri.toString() ||
        navigation.version !== document.version
      )
        this.proposedNavigation = null;
      else if (position.line === navigation.line || position.line === navigation.line - 1) {
        if (!navigation.scheduled) {
          navigation.scheduled = true;
          setTimeout(() => {
            if (this.proposedNavigation !== navigation) return;
            this.proposedNavigation = null;
            const editor = vscode.window.activeTextEditor;
            if (
              editor?.document === navigation.document &&
              editor?.document.uri.toString() === navigation.uri &&
              editor.document.version === navigation.version &&
              (editor.selection.active.line === navigation.line ||
                editor.selection.active.line === navigation.line - 1)
            )
              void vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
          }, 0);
        }
        return;
      } else if (
        this.lastInlineEdit &&
        (position.line !== this.lastInlineEdit.line ||
          position.character !== this.lastInlineEdit.character)
      )
        this.proposedNavigation = null;
    }
    if (!this.lastInlineEdit) return;
    const currentUri = document.uri.toString();
    if (currentUri !== this.lastInlineEdit.uri) {
      console.log("[Sweep] Clearing inline edit: active document changed");
      this.clearInlineEdit("active document changed");
      return;
    }

    const shown = this.lastInlineEdit;
    if (
      shown.insertion !== null &&
      position.line === shown.line &&
      position.character >= shown.character
    ) {
      const oldOffset = document.offsetAt(new vscode.Position(shown.line, shown.character));
      const inserted = this.extractInsertedTextAtCursor(
        shown.content,
        document.getText(),
        oldOffset,
      );
      if (
        inserted &&
        shown.insertion.startsWith(inserted) &&
        position.character === shown.character + inserted.length
      )
        return;
    }

    if (
      position.line !== this.lastInlineEdit.line ||
      position.character !== this.lastInlineEdit.character ||
      document.version !== this.lastInlineEdit.version
    ) {
      console.log("[Sweep] Clearing inline edit: cursor moved away", {
        originalLine: this.lastInlineEdit.line,
        currentLine: position.line,
        originalCharacter: this.lastInlineEdit.character,
        currentCharacter: position.character,
        originalVersion: this.lastInlineEdit.version,
        currentVersion: document.version,
      });
      this.clearInlineEdit("cursor moved away");
    }
  }

  handleInlineAccept(
    payload: AutocompleteMetricsPayload,
    acceptedSuggestion?: AcceptedInlineSuggestion,
  ): void {
    if (this.fimSession?.fim) {
      this.cancelInFlightRequest("FIM suggestion accepted");
      this.fimSession = null;
    }
    if (this.lastInlineEdit?.payload.id === payload.id) {
      this.lastInlineEdit = null;
      this.proposedNavigation = null;
    }
    if (!acceptedSuggestion) {
      this.clearSuggestionQueue("accepted suggestion lacked queue metadata");
      void vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
      return;
    }
    if (acceptedSuggestion.cursorTargetOffset !== undefined) {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.uri.toString() === acceptedSuggestion.uri) {
        const point = editor.document.positionAt(
          acceptedSuggestion.startIndex +
            Math.max(
              0,
              Math.min(acceptedSuggestion.completion.length, acceptedSuggestion.cursorTargetOffset),
            ),
        );
        editor.selection = new vscode.Selection(point, point);
        editor.revealRange?.(new vscode.Range(point, point));
      }
    }
    this.adjustQueuedSuggestionsAfterAccept(acceptedSuggestion);
    if (this.queuedSuggestions?.suggestions.length) {
      this.shouldConsumeQueuedSuggestion = true;
      void vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
      return;
    }
    this.clearSuggestionQueue("accepted suggestion exhausted queue");
    void vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
  }

  private clearInlineEdit(
    reason: string,
    options?: { trackDisposed?: boolean; hideSuggestion?: boolean; preserveQueue?: boolean },
  ): void {
    if (!this.lastInlineEdit) return;
    const payload = this.lastInlineEdit.payload;
    const shouldTrackDisposed = options?.trackDisposed ?? true;
    const shouldHideSuggestion = options?.hideSuggestion ?? true;

    if (shouldTrackDisposed) {
      this.metricsTracker.trackDisposed(payload);
    }
    this.lastInlineEdit = null;
    if (!options?.preserveQueue)
      this.clearSuggestionQueue(reason ? `inline cleared: ${reason}` : undefined);

    if (shouldHideSuggestion) {
      void vscode.commands.executeCommand("editor.action.inlineSuggest.hide");
    }

    if (reason) {
      console.log("[Sweep] Inline edit cleared:", reason);
    }
  }

  private setSuggestionQueue(uri: string, suggestions: AutocompleteResult[]): void {
    if (suggestions.length === 0) {
      this.queuedSuggestions = null;
      this.shouldConsumeQueuedSuggestion = false;
      return;
    }
    this.queuedSuggestions = { uri, suggestions: [...suggestions] };
    this.shouldConsumeQueuedSuggestion = false;
  }

  private clearSuggestionQueue(reason?: string): void {
    const hadQueuedSuggestions = this.queuedSuggestions !== null;
    this.queuedSuggestions = null;
    this.shouldConsumeQueuedSuggestion = false;
    if (reason && hadQueuedSuggestions) {
      console.log("[Sweep] Cleared queued suggestions:", reason);
    }
  }

  private consumeQueuedSuggestion(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.InlineCompletionList | undefined {
    const queue = this.queuedSuggestions;
    if (!queue || queue.suggestions.length === 0) return undefined;
    const uri = document.uri.toString();
    if (queue.uri !== uri) {
      this.clearSuggestionQueue("active document changed");
      return undefined;
    }

    while (queue.suggestions.length > 0) {
      const next = queue.suggestions.shift();
      if (!next) break;
      const normalized = this.normalizeInlineResult(document, position, next);
      if (!normalized) continue;
      if (this.isNoOpSuggestion(document, normalized)) continue;

      const classification = this.jumpEditManager.classifyEditDisplay(
        document,
        position,
        normalized,
      );
      if (classification.decision === "SUPPRESS") {
        continue;
      }
      if (classification.decision === "JUMP") {
        console.log("[Sweep] Rendering queued suggestion as jump edit", {
          id: normalized.id,
          remaining: queue.suggestions.length,
        });
        this.shouldConsumeQueuedSuggestion = false;
        return this.buildCompletionItem(document, position, normalized, true);
      }

      console.log("[Sweep] Rendering queued inline edit suggestion", {
        id: normalized.id,
        remaining: queue.suggestions.length,
      });
      this.shouldConsumeQueuedSuggestion = false;
      return this.buildCompletionItem(document, position, normalized);
    }

    this.clearSuggestionQueue("queue exhausted");
    return undefined;
  }

  private adjustQueuedSuggestionsAfterAccept(acceptedSuggestion: AcceptedInlineSuggestion): void {
    if (!this.queuedSuggestions?.suggestions.length) return;
    const replacementLength = acceptedSuggestion.endIndex - acceptedSuggestion.startIndex;
    const adjustment = acceptedSuggestion.completion.length - replacementLength;
    if (adjustment === 0) return;

    this.queuedSuggestions.suggestions = this.queuedSuggestions.suggestions.map((suggestion) => {
      if (suggestion.startIndex < acceptedSuggestion.endIndex) {
        return suggestion;
      }
      return {
        ...suggestion,
        startIndex: suggestion.startIndex + adjustment,
        endIndex: suggestion.endIndex + adjustment,
      };
    });
  }

  private isNoOpSuggestion(document: vscode.TextDocument, result: AutocompleteResult): boolean {
    const oldContent = document.getText(
      new vscode.Range(
        document.positionAt(result.startIndex),
        document.positionAt(result.endIndex),
      ),
    );
    const isNoOp = oldContent === result.completion;
    if (isNoOp) {
      console.log(
        "[Sweep] Inline edit response is a no-op after trimming newlines; skipping render",
        { id: result.id },
      );
    }
    return isNoOp;
  }

  private tryBuildGhostTextExtension(
    snapshot: {
      uri: string;
      version: number;
      position: vscode.Position;
      content: string;
    },
    document: vscode.TextDocument,
    results: AutocompleteResult[],
  ): AutocompleteResult[] | null {
    const firstResult = results[0];
    if (!firstResult) return null;

    const currentText = document.getText();
    const snapshotCursorOffset = Math.min(
      document.offsetAt(snapshot.position),
      snapshot.content.length,
    );
    const userInsertedText = this.extractInsertedTextAtCursor(
      snapshot.content,
      currentText,
      snapshotCursorOffset,
    );
    if (!userInsertedText) return null;

    const suggestedText =
      snapshot.content.slice(0, firstResult.startIndex) +
      firstResult.completion +
      snapshot.content.slice(firstResult.endIndex);
    const suggestedInsertedText = this.extractInsertedTextAtCursor(
      snapshot.content,
      suggestedText,
      snapshotCursorOffset,
    );
    if (!suggestedInsertedText || !suggestedInsertedText.startsWith(userInsertedText)) {
      return null;
    }

    const extendedCompletion = suggestedInsertedText.slice(userInsertedText.length);
    if (!extendedCompletion) {
      return null;
    }

    const activeEditor = vscode.window.activeTextEditor;
    const currentCursorOffset =
      activeEditor?.document.uri.toString() === snapshot.uri
        ? activeEditor.document.offsetAt(activeEditor.selection.active)
        : snapshotCursorOffset + userInsertedText.length;

    const adjustedFirst: AutocompleteResult = {
      ...firstResult,
      startIndex: currentCursorOffset,
      endIndex: currentCursorOffset,
      completion: extendedCompletion,
    };
    const adjustmentOffset = userInsertedText.length;
    const adjustedRemainder = results.slice(1).map((result) => ({
      ...result,
      startIndex: result.startIndex + adjustmentOffset,
      endIndex: result.endIndex + adjustmentOffset,
    }));

    console.log("[Sweep] Rendering extension from stale inline response", {
      id: adjustedFirst.id,
      adjustmentOffset,
    });

    return [adjustedFirst, ...adjustedRemainder];
  }

  private extractInsertedTextAtCursor(
    originalText: string,
    updatedText: string,
    cursorOffset: number,
  ): string | null {
    const prefix = originalText.slice(0, cursorOffset);
    const suffix = originalText.slice(cursorOffset);
    if (!updatedText.startsWith(prefix) || !updatedText.endsWith(suffix)) {
      return null;
    }
    const insertedText = updatedText.slice(prefix.length, updatedText.length - suffix.length);
    return insertedText.length > 0 ? insertedText : null;
  }

  private buildInput(
    document: vscode.TextDocument,
    position: vscode.Position,
    originalContent: string,
  ): AutocompleteInput {
    const maxContextFiles = config.maxContextFiles;

    const recentBuffers = this.buildRecentBuffers(document, maxContextFiles);

    const recentChanges = this.tracker.getEditDiffHistory().map((record) => ({
      path: record.filepath,
      diff: record.diff,
    }));

    const userActions = this.tracker.getUserActions(document.fileName, {
      line: position.line,
      offset: utf8ByteOffsetAt(document, position),
    });

    return {
      document,
      position,
      originalContent,
      recentChanges,
      recentBuffers,
      diagnostics: vscode.languages.getDiagnostics(document.uri),
      userActions,
    };
  }

  private buildRecentBuffers(
    document: vscode.TextDocument,
    maxFiles: number,
  ): AutocompleteInput["recentBuffers"] {
    const currentUri = document.uri.toString();
    const buffers: AutocompleteInput["recentBuffers"] = [];
    const seen = new Set<string>();

    const addBuffer = (buffer: AutocompleteInput["recentBuffers"][number]) => {
      if (seen.has(buffer.path)) return;
      seen.add(buffer.path);
      buffers.push(buffer);
    };

    for (const buffer of this.buildVisibleEditorBuffers(currentUri)) {
      addBuffer(buffer);
    }

    const recentFiles = this.tracker.getRecentContextFiles(currentUri, maxFiles * 2);
    for (const file of recentFiles) {
      const buffer = this.buildBufferFromSnapshot(file);
      if (!buffer) continue;
      addBuffer(buffer);
    }

    return buffers.slice(0, maxFiles);
  }

  private buildVisibleEditorBuffers(currentUri: string): AutocompleteInput["recentBuffers"] {
    const buffers: AutocompleteInput["recentBuffers"] = [];

    for (const editor of vscode.window.visibleTextEditors) {
      const document = editor.document;
      if (document.uri.toString() === currentUri) continue;

      const range = this.getPrimaryVisibleRange(editor);
      const focusLine = editor.selection.active.line;
      const chunk = this.buildChunkFromDocument(document, {
        visibleRange: range,
        focusLine,
      });
      if (!chunk) continue;

      buffers.push({
        path: this.getRelativePathForUri(document.uri),
        content: chunk.content,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      });
    }

    return buffers;
  }

  private getPrimaryVisibleRange(editor: vscode.TextEditor): vscode.Range | null {
    const ranges = editor.visibleRanges;
    if (ranges.length === 0) return null;

    const activeLine = editor.selection.active.line;
    const containingRange = ranges.find(
      (range) => activeLine >= range.start.line && activeLine <= range.end.line,
    );
    return containingRange ?? ranges[0] ?? null;
  }

  private buildBufferFromSnapshot(file: {
    filepath: string;
    content: string;
    mtime?: number;
    cursorLine?: number;
  }): AutocompleteInput["recentBuffers"][number] | null {
    if (isFileTooLarge(file.content)) return null;
    const lines = file.content.split("\n");
    const totalLines = lines.length;
    if (totalLines === 0) return null;

    const focusLine = file.cursorLine ?? 0;
    const { startLine, endLine } = this.buildLineWindow(0, totalLines, focusLine);
    const content = lines.slice(startLine, endLine).join("\n");

    return {
      path: file.filepath,
      content,
      startLine,
      endLine,
      ...(file.mtime !== undefined ? { mtime: file.mtime } : {}),
    };
  }

  private buildChunkFromDocument(
    document: vscode.TextDocument,
    options: {
      visibleRange: vscode.Range | null;
      focusLine: number;
    },
  ): { content: string; startLine: number; endLine: number } | null {
    const totalLines = document.lineCount;
    if (totalLines === 0) return null;

    if (options.visibleRange) {
      const rangeStart = options.visibleRange.start.line;
      const rangeEnd = Math.min(totalLines, options.visibleRange.end.line + 1);
      if (rangeEnd - rangeStart <= MAX_FILE_CHUNK_LINES) {
        return this.buildChunkFromRange(document, rangeStart, rangeEnd);
      }
      const { startLine, endLine } = this.buildLineWindow(rangeStart, rangeEnd, options.focusLine);
      return this.buildChunkFromRange(document, startLine, endLine);
    }

    const { startLine, endLine } = this.buildLineWindow(0, totalLines, options.focusLine);
    return this.buildChunkFromRange(document, startLine, endLine);
  }

  private buildChunkFromRange(
    document: vscode.TextDocument,
    startLine: number,
    endLine: number,
  ): { content: string; startLine: number; endLine: number } {
    const clampedStart = Math.max(0, Math.min(startLine, document.lineCount));
    const clampedEnd = Math.max(clampedStart, Math.min(endLine, document.lineCount));
    const range = new vscode.Range(
      new vscode.Position(clampedStart, 0),
      new vscode.Position(clampedEnd, 0),
    );
    const content = document.getText(range);
    return { content, startLine: clampedStart, endLine: clampedEnd };
  }

  private buildLineWindow(
    minLine: number,
    maxLine: number,
    focusLine: number,
  ): { startLine: number; endLine: number } {
    const span = Math.min(MAX_FILE_CHUNK_LINES, maxLine - minLine);
    if (span <= 0) return { startLine: minLine, endLine: minLine };

    const clampedFocus = Math.min(Math.max(focusLine, minLine), Math.max(minLine, maxLine - 1));
    let startLine = clampedFocus - Math.floor(span / 2);
    startLine = Math.max(minLine, Math.min(startLine, maxLine - span));
    const endLine = startLine + span;
    return { startLine, endLine };
  }

  private getRelativePathForUri(uri: vscode.Uri): string {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (workspaceFolder) {
      const relativePath = uri.fsPath.slice(workspaceFolder.uri.fsPath.length + 1);
      return normalizePathSeparators(relativePath);
    }
    return normalizePathSeparators(uri.fsPath);
  }

  private normalizeInlineResult(
    document: vscode.TextDocument,
    position: vscode.Position,
    result: AutocompleteResult,
  ): AutocompleteResult | null {
    const cursorOffset = document.offsetAt(position);
    const length = document.getText().length;
    if (
      !Number.isInteger(result.startIndex) ||
      !Number.isInteger(result.endIndex) ||
      result.startIndex < 0 ||
      result.endIndex < result.startIndex ||
      result.endIndex > length
    )
      return null;

    if (result.startIndex >= cursorOffset)
      return this.trimSuffixOverlap(document, position, result);

    // Keep the original range for routing: an edit before the cursor is a jump.
    return result;
  }

  private trimSuffixOverlap(
    document: vscode.TextDocument,
    position: vscode.Position,
    result: AutocompleteResult,
  ): AutocompleteResult | null {
    if (!result.completion) return result.endIndex > result.startIndex ? result : null;
    // Only trim overlap for insertions; replacement text already owns its range.
    if (result.endIndex !== result.startIndex) return result;

    const cursorOffset = document.offsetAt(position);
    const documentLength = document.getText().length;
    const maxLookahead = Math.min(documentLength - cursorOffset, result.completion.length);
    if (maxLookahead <= 0) return result;

    const followingText = document.getText(
      new vscode.Range(position, document.positionAt(cursorOffset + maxLookahead)),
    );

    let overlap = 0;
    for (let i = maxLookahead; i > 0; i--) {
      if (result.completion.endsWith(followingText.slice(0, i))) {
        overlap = i;
        break;
      }
    }

    if (overlap === 0 || !followingText.slice(0, overlap).includes("\n")) return result;

    const trimmedCompletion = result.completion.slice(0, result.completion.length - overlap);
    if (trimmedCompletion.length === 0) return null;

    const target = (result as AutocompleteResult & { cursorTargetOffset?: number })
      .cursorTargetOffset;
    return {
      id: result.id,
      startIndex: result.startIndex,
      endIndex: result.endIndex,
      completion: trimmedCompletion,
      ...(result.source ? { source: result.source } : {}),
      ...(target !== undefined && target <= trimmedCompletion.length
        ? { cursorTargetOffset: target }
        : {}),
    };
  }

  private isRequestStale(
    snapshot: {
      uri: string;
      version: number;
      position: vscode.Position;
      content: string;
    },
    token: vscode.CancellationToken,
  ): boolean {
    if (token.isCancellationRequested) return true;
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) return true;
    if (!vscode.window.state.focused) return true;
    if (activeEditor.document.uri.toString() !== snapshot.uri) return true;
    if (activeEditor.document.version !== snapshot.version) return true;
    if (activeEditor.document.getText() !== snapshot.content) return true;
    const activePosition = activeEditor.selection.active;
    return (
      activePosition.line !== snapshot.position.line ||
      activePosition.character !== snapshot.position.character
    );
  }

  private isRequestContextCurrent(
    snapshot: RequestSnapshot,
    token: vscode.CancellationToken,
  ): boolean {
    if (token.isCancellationRequested) return false;
    const editor = vscode.window.activeTextEditor;
    if (!editor || !vscode.window.state.focused) return false;
    if (editor.document.uri.toString() !== snapshot.uri) return false;
    if (editor.document.version === snapshot.version) {
      const active = editor.selection.active;
      return (
        active.line === snapshot.position.line &&
        active.character === snapshot.position.character &&
        editor.document.getText() === snapshot.content
      );
    }
    const inserted = this.extractInsertedTextAtCursor(
      snapshot.content,
      editor.document.getText(),
      editor.document.offsetAt(snapshot.position),
    );
    const active = editor.selection.active;
    return Boolean(
      inserted &&
      /^[A-Za-z0-9_]+$/.test(inserted) &&
      active.line === snapshot.position.line &&
      active.character === snapshot.position.character + inserted.length,
    );
  }
}
