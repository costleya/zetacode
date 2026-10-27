#!/usr/bin/env -S node --experimental-transform-types
/**
 * Full production ApiClient parity adapter. It supplies only synthetic VS
 * Code documents/workspace providers and a CompletionServer seam; requests
 * still pass through the selected source tree's ApiClient and real
 * CompletionClient. It never starts a server or reports editor presentation.
 *
 * Set NES_SOURCE_ROOT to the reference source tree and NES_GRPC_SOCKET to an
 * already-running production gRPC socket before invoking the parity runner.
 */
import { registerHooks } from "node:module";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const defaultRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourceRoot = path.resolve(process.env.NES_SOURCE_ROOT || defaultRoot);
const sourceUrl = pathToFileURL(`${sourceRoot}${path.sep}`);
const referenceBuild = sourceRoot === "/private/tmp/nes-rebuild-reference";
const referenceIdentity = referenceBuild
  ? "Pinned reference JS bundle 6394ca41a51f84add687630ce62a1df5fdb9f6b45164af3345d7c9e24d549a6b; bundle comparison normalized only 526 Rollup build-root labels and matched installed bundle SHA-256 2a7ebcffde057254f84001000c1d10fd61886dad56d7a63132b84092a3ea7815"
  : "Rebuilt checkout source; installed-bundle identity is not asserted by this adapter";
const workspaceBase = path.resolve(
  process.env.NES_PARITY_WORKSPACE_ROOT || path.join(os.tmpdir(), "nesweep-parity-request-adapter"),
);
const socketPath = process.env.NES_GRPC_SOCKET;
const configuredSettings = process.env.NES_VSCODE_SETTINGS_JSON
  ? JSON.parse(process.env.NES_VSCODE_SETTINGS_JSON)
  : {};

class Uri {
  constructor(fsPath) {
    this.fsPath = path.resolve(fsPath);
    this.path = this.fsPath;
    this.scheme = "file";
  }
  toString() {
    return pathToFileURL(this.fsPath).href;
  }
  static file(fsPath) {
    return new Uri(fsPath);
  }
  static parse(value) {
    return value.startsWith("file:") ? new Uri(fileURLToPath(value)) : new Uri(value);
  }
  static joinPath(uri, ...segments) {
    return new Uri(path.join(uri.fsPath, ...segments));
  }
}

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(startLineOrPosition, startCharacterOrPosition, endLine, endCharacter) {
    if (typeof startLineOrPosition === "number") {
      this.start = new Position(startLineOrPosition, startCharacterOrPosition);
      this.end = new Position(endLine, endCharacter);
    } else {
      this.start = startLineOrPosition;
      this.end = startCharacterOrPosition;
    }
  }
}

class Location {
  constructor(uri, range) {
    this.uri = uri;
    this.range = range;
  }
}

class EventEmitter {
  listeners = new Set();
  event = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value) {
    for (const listener of this.listeners) listener(value);
  }
  dispose() {
    this.listeners.clear();
  }
}

const state = {
  workspaceRoot: null,
  workspaceUri: null,
  documents: [],
  relatedLocations: [],
  relatedDocuments: [],
  loggerEvents: [],
};
const ownedCaseRoots = new Set();
const workspace = {
  get textDocuments() {
    return state.documents;
  },
  get workspaceFolders() {
    return state.workspaceUri
      ? [{ name: "parity-fixture", uri: state.workspaceUri, index: 0 }]
      : [];
  },
  getWorkspaceFolder(uri) {
    if (!state.workspaceRoot || !uri?.fsPath) return undefined;
    const relative = path.relative(state.workspaceRoot, uri.fsPath);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return { name: "parity-fixture", uri: state.workspaceUri, index: 0 };
    }
    return undefined;
  },
  getConfiguration() {
    return {
      get: (key, fallback) =>
        Object.hasOwn(configuredSettings, key) ? configuredSettings[key] : fallback,
      inspect: () => undefined,
      update: async () => {},
    };
  },
  fs: {
    stat: async (uri) => {
      const result = await stat(uri.fsPath);
      return { ctime: result.ctimeMs, mtime: result.mtimeMs, size: result.size, type: 1 };
    },
    readFile: async (uri) => new Uint8Array(await readFile(uri.fsPath)),
  },
};
const vscodeShim = {
  version: "1.142.0",
  workspace,
  commands: {
    executeCommand: async (command) =>
      command === "vscode.executeDefinitionProvider" ? state.relatedLocations : [],
  },
  env: { clipboard: { readText: async () => "" } },
  extensions: { getExtension: () => ({ packageJSON: { version: "1.2.7" } }) },
  window: {
    createOutputChannel: () => ({
      trace() {},
      debug() {},
      info() {},
      warn() {},
      error: (...args) => state.loggerEvents.push(args.map(String).join(" ")),
    }),
  },
  Uri,
  Position,
  Range,
  Location,
  EventEmitter,
  Disposable: class Disposable {
    constructor(dispose) {
      this.dispose = dispose;
    }
  },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
};
globalThis.__nesweepParityVscode = vscodeShim;

const vscodeData = encodeURIComponent(`
const v = globalThis.__nesweepParityVscode;
export const version = v.version;
export const workspace = v.workspace;
export const commands = v.commands;
export const env = v.env;
export const extensions = v.extensions;
export const window = v.window;
export const Uri = v.Uri;
export const Position = v.Position;
export const Range = v.Range;
export const Location = v.Location;
export const EventEmitter = v.EventEmitter;
export const Disposable = v.Disposable;
export const DiagnosticSeverity = v.DiagnosticSeverity;
export const ConfigurationTarget = v.ConfigurationTarget;
`);
const vscodeUrl = `data:text/javascript;charset=utf-8,${vscodeData}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("~/")) {
      return nextResolve(new URL(`src/${specifier.slice(2)}`, sourceUrl).href, context);
    }
    if (specifier === "vscode") return { url: vscodeUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const importSource = (relativePath) => import(new URL(relativePath, sourceUrl).href);
const [apiModule, completionModule, configModule, loggerModule] = await Promise.all([
  importSource("src/api/client.ts"),
  importSource("src/api/completion-client.ts"),
  importSource("src/core/config.ts"),
  importSource("src/core/logger.ts"),
]);
const ApiClient = apiModule.ApiClient;
const CompletionClient = completionModule.CompletionClient;
const productionConfig = configModule.config;
loggerModule.initLogger();
if (!socketPath) {
  throw new Error("Set NES_GRPC_SOCKET to an already-running production gRPC Unix socket");
}
const now = () => performance.now();
const writeJson = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const logError = (message) => process.stderr.write(`${message}\n`);

let syntheticDocumentCount = 0;

class SyntheticDocument {
  constructor(uri, languageId, text) {
    this.instanceId = `synthetic-document-${++syntheticDocumentCount}`;
    this.uri = uri;
    this.fileName = uri.fsPath;
    this.languageId = languageId;
    this.text = text;
    this.version = 1;
    this.eol = 1;
    this.isClosed = false;
    this.lines = text.split("\n");
    this.lineCount = this.lines.length;
  }
  updateText(text) {
    if (this.text === text) return;
    this.text = text;
    this.lines = text.split("\n");
    this.lineCount = this.lines.length;
    this.version++;
  }
  getText(range) {
    if (!range) return this.text;
    return this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
  }
  offsetAt(position) {
    const line = Math.max(0, Math.min(position.line, this.lines.length - 1));
    const start = this.lines.slice(0, line).reduce((sum, value) => sum + value.length + 1, 0);
    return Math.min(this.text.length, start + position.character);
  }
  positionAt(offset) {
    const bounded = Math.max(0, Math.min(offset, this.text.length));
    const before = this.text.slice(0, bounded);
    const line = before.split("\n").length - 1;
    const lineStart = before.lastIndexOf("\n") + 1;
    return new Position(line, bounded - lineStart);
  }
  lineAt(line) {
    if (line < 0 || line >= this.lines.length) throw new RangeError(`No line ${line}`);
    const text = this.lines[line];
    const start = this.offsetAt(new Position(line, 0));
    const end = start + text.length;
    return {
      text,
      range: new Range(new Position(line, 0), new Position(line, text.length)),
      rangeIncludingLineBreak: new Range(
        new Position(line, 0),
        new Position(
          line + (line + 1 < this.lines.length ? 1 : 0),
          line + 1 < this.lines.length ? 0 : text.length,
        ),
      ),
      firstNonWhitespaceCharacterIndex: text.search(/\S|$/),
      isEmptyOrWhitespace: text.trim().length === 0,
      start,
      end,
    };
  }
}

function cursorFixture(testCase, step) {
  const insertion = typeof step.insert === "string" ? step.insert : "";
  const anchorIndex = testCase.text.lastIndexOf(testCase.cursorAfter);
  if (anchorIndex < 0) throw new Error(`${testCase.id}: cursorAfter is not in text`);
  const cursorBeforeInsert = anchorIndex + testCase.cursorAfter.length;
  const text = `${testCase.text.slice(0, cursorBeforeInsert)}${insertion}${testCase.text.slice(cursorBeforeInsert)}`;
  const cursorUtf16 = cursorBeforeInsert + insertion.length;
  const beforeCursor = text.slice(0, cursorUtf16);
  const line = beforeCursor.split("\n").length - 1;
  const character = cursorUtf16 - (beforeCursor.lastIndexOf("\n") + 1);
  return { text, position: new Position(line, character), cursorUtf16 };
}

function lineDiff(before, after) {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  let start = 0;
  while (start < beforeLines.length && beforeLines[start] === afterLines[start]) start++;
  let oldEnd = beforeLines.length;
  let newEnd = afterLines.length;
  while (oldEnd > start && newEnd > start && beforeLines[oldEnd - 1] === afterLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return [
    ...beforeLines.slice(start, oldEnd).map((line) => `-${line}`),
    ...afterLines.slice(start, newEnd).map((line) => `+${line}`),
  ].join("\n");
}

function makeDiagnostics(testCase) {
  return (testCase.diagnostics ?? []).map((diagnostic) => {
    const line = diagnostic.line - 1;
    const start = new Position(line, 0);
    return {
      range: new Range(start, new Position(line, 1)),
      message: diagnostic.message,
      severity: diagnostic.severity === "error" ? 0 : diagnostic.severity === "warning" ? 1 : 2,
      source: "parity-fixture",
    };
  });
}

function createCaseState(testCase, fixture, caseStates) {
  const existing = caseStates.get(testCase.id);
  if (existing) {
    existing.document.updateText(fixture.text);
    state.workspaceRoot = existing.caseRoot;
    state.workspaceUri = existing.workspaceUri;
    state.documents = [existing.document, ...existing.relatedDocuments];
    state.relatedDocuments = existing.relatedDocuments;
    state.relatedLocations = existing.relatedLocations;
    return existing;
  }

  const caseRoot = path.join(workspaceBase, testCase.id);
  const workspaceUri = Uri.file(caseRoot);
  const document = new SyntheticDocument(
    Uri.file(path.join(caseRoot, testCase.path)),
    testCase.language,
    fixture.text,
  );
  const relatedDocuments = (testCase.related ?? []).map(
    (related) =>
      new SyntheticDocument(
        Uri.file(path.join(caseRoot, related.path)),
        related.path.endsWith(".py") ? "python" : "typescript",
        related.text,
      ),
  );
  const relatedLocations = relatedDocuments.map(
    (related) => new Location(related.uri, new Range(new Position(0, 0), new Position(0, 1))),
  );
  const fixtureState = { caseRoot, workspaceUri, document, relatedDocuments, relatedLocations };
  caseStates.set(testCase.id, fixtureState);
  state.workspaceRoot = caseRoot;
  state.workspaceUri = workspaceUri;
  state.documents = [document, ...relatedDocuments];
  state.relatedDocuments = relatedDocuments;
  state.relatedLocations = relatedLocations;
  return fixtureState;
}

async function prepareWorkspace(caseRoot, testCase) {
  await mkdir(caseRoot, { recursive: true });
  const rulesFile = path.join(caseRoot, ".vscode", `nes-${testCase.language}.md`);
  if (typeof testCase.rules === "string" && testCase.rules.trim()) {
    await mkdir(path.dirname(rulesFile), { recursive: true });
    await writeFile(rulesFile, testCase.rules, "utf8");
  } else {
    await rm(rulesFile, { force: true });
  }
}

function makeInput(testCase, fixture, document, step, events, started) {
  const changes =
    fixture.text === testCase.text
      ? []
      : [{ path: document.fileName, diff: lineDiff(testCase.text, fixture.text) }];
  const actions =
    typeof step.insert === "string" && step.insert.length > 0
      ? [
          {
            action_type: "INSERT_CHAR",
            line_number: fixture.position.line + 1,
            offset: fixture.position.character,
            file_path: document.fileName,
            timestamp: Date.now(),
          },
        ]
      : [];
  let sourceUsableMs = null;
  const intermediateResults = [];
  return {
    input: {
      document,
      position: fixture.position,
      originalContent: testCase.text,
      recentChanges: changes,
      recentBuffers: [],
      diagnostics: makeDiagnostics(testCase),
      userActions: actions,
      canUseContinuationFallback: () => true,
      onIntermediateResults: (results) => {
        const elapsed = now() - started;
        if (results?.length && applyResult(fixture.text, results[0]) && sourceUsableMs === null) {
          sourceUsableMs = elapsed;
        }
        intermediateResults.push({ atMs: elapsed, results });
        events.push({
          type: "api_intermediate_results",
          atMs: elapsed,
          count: results?.length ?? 0,
          sources: (results ?? []).map((result) => result.source ?? "zeta"),
        });
      },
    },
    getSourceUsableMs: () => sourceUsableMs,
    getIntermediateResults: () => intermediateResults,
  };
}

function applyResult(text, result) {
  if (!result || !Number.isInteger(result.startIndex) || !Number.isInteger(result.endIndex))
    return null;
  if (result.startIndex < 0 || result.endIndex < result.startIndex || result.endIndex > text.length)
    return null;
  return {
    edit: { start: result.startIndex, end: result.endIndex, text: result.completion },
    appliedText: `${text.slice(0, result.startIndex)}${result.completion}${text.slice(result.endIndex)}`,
  };
}

function createCompletionServer(capture, sequenceStarted) {
  const realClient = new CompletionClient({ socketPath });
  const client = {
    complete: async (request, signal) => {
      // Capture the current step's containers now. A cancelled speculative
      // continuation may settle during the next step; it belongs to the step
      // that launched it, even though the ApiClient remains sequence-scoped.
      const records = capture.rpcRecords;
      const counters = capture.counters;
      const rpc = {
        model: request.model,
        prompt: request.prompt,
        startedAtMs: now() - sequenceStarted,
        firstTokenAtMs: null,
        completedAtMs: null,
        grpcMs: null,
        generated: "",
        finishReason: "unavailable",
        error: "",
      };
      records.push(rpc);
      const started = now();
      const originalFirstToken = request.onFirstToken;
      const wrappedRequest = {
        ...request,
        onFirstToken: () => {
          rpc.firstTokenAtMs = now() - sequenceStarted;
          originalFirstToken?.();
        },
      };
      try {
        const response = await realClient.complete(wrappedRequest, signal);
        rpc.generated = response.text;
        rpc.finishReason = response.finishReason;
        return response;
      } catch (error) {
        rpc.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        rpc.completedAtMs = now() - sequenceStarted;
        rpc.grpcMs = now() - started;
        counters.grpcMs += rpc.grpcMs;
      }
    },
  };
  return {
    client: realClient,
    server: {
      // The seam satisfies ApiClient's readiness contract but does not
      // initialize or probe an external server.
      waitUntilReady: async () => {},
      getClient: () => client,
      reportSuccess: () => capture.counters.serverSuccesses++,
      reportFailure: () => capture.counters.serverFailures++,
    },
  };
}

function pickPrimaryRpc(records, primaryModel) {
  return [...records].reverse().find((record) => record.model === primaryModel);
}

async function runSequence(message, sourceRootForSequence) {
  if (message?.type !== "sequence" || !message.sequence || !Array.isArray(message.sequence.steps)) {
    throw new Error("Expected one sequence message from tools/parity/run.mjs");
  }
  const cases = new Map(message.cases.map((testCase) => [testCase.id, testCase]));
  const observations = [];
  const sequenceStarted = now();
  const apiResultsCacheEnabled = Boolean(productionConfig.reuseIdenticalPromptResults);
  const caseStates = new Map();
  const capture = {
    rpcRecords: [],
    counters: { grpcMs: 0, serverSuccesses: 0, serverFailures: 0 },
  };
  const { client, server } = createCompletionServer(capture, sequenceStarted);
  const api = new ApiClient(server, {
    // These loaders are synthetic workspace/LSP providers, preserving the
    // production retrieval code while keeping all data inside the fixture.
    retrievalFileLoader: async (uri) => new Uint8Array(await readFile(uri.fsPath)),
    openDocumentsProvider: () => state.documents,
    documentSymbolLoader: async () => [],
  });
  let lastSuccessfulPrimary = null;

  try {
    for (let stepIndex = 0; stepIndex < message.sequence.steps.length; stepIndex++) {
      const step = message.sequence.steps[stepIndex];
      const testCase = cases.get(step.case);
      if (!testCase) throw new Error(`Unknown parity case: ${step.case}`);
      const fixture = cursorFixture(testCase, step);
      const caseRoot = path.join(workspaceBase, testCase.id);
      if (!ownedCaseRoots.has(caseRoot)) {
        try {
          await stat(caseRoot);
          throw new Error(
            `Synthetic workspace already exists at ${caseRoot}; remove it or choose another NES_PARITY_WORKSPACE_ROOT`,
          );
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        ownedCaseRoots.add(caseRoot);
        await prepareWorkspace(caseRoot, testCase);
      }
      const { document, relatedDocuments } = createCaseState(testCase, fixture, caseStates);
      capture.rpcRecords = [];
      capture.counters = { grpcMs: 0, serverSuccesses: 0, serverFailures: 0 };
      state.loggerEvents = [];

      const started = now();
      const events = [{ type: "api_request_started", atMs: 0 }];
      const { input, getSourceUsableMs, getIntermediateResults } = makeInput(
        testCase,
        fixture,
        document,
        step,
        events,
        started,
      );
      let apiResults = null;
      let failure = "";
      try {
        apiResults = await api.getAutocomplete(input);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        logError(`${message.sequence.id}/${stepIndex}: ${failure}`);
      }
      const completeMs = now() - started;
      const rpcRecords = capture.rpcRecords;
      const counters = capture.counters;
      const primaryRpc = pickPrimaryRpc(rpcRecords, "zeta-2.1");
      const selected = apiResults?.[0] ?? null;
      const applied = applyResult(fixture.text, selected);
      const cacheHit =
        apiResultsCacheEnabled &&
        !primaryRpc &&
        lastSuccessfulPrimary !== null &&
        !failure &&
        completeMs < productionConfig.completionTimeoutMs;
      const primaryForEvidence = primaryRpc ?? (cacheHit ? lastSuccessfulPrimary.rpc : null);
      if (applied) {
        const sourceUsableMs = getSourceUsableMs() ?? completeMs;
        events.push({
          type: "api_result_available",
          atMs: sourceUsableMs,
          source: selected.source ?? (cacheHit ? "api-result-cache" : "zeta"),
        });
      }
      if (cacheHit) {
        events.push({
          type: "api_identical_prompt_cache_reused",
          atMs: completeMs,
          sourceStep: lastSuccessfulPrimary.step,
        });
      }
      events.push({
        type: "api_request_completed",
        atMs: completeMs,
        resultCount: apiResults?.length ?? 0,
      });

      const primaryRpcFailed = rpcRecords.some((rpc) => rpc.model === "zeta-2.1" && rpc.error);
      const classification =
        failure || (primaryRpcFailed && !applied) ? "error" : applied ? "usable" : "no-edit";
      observations.push({
        type: "result",
        step: stepIndex,
        fixtureDocument: { id: document.instanceId, version: document.version },
        prompt: primaryForEvidence?.prompt ?? "",
        generated: primaryForEvidence?.generated ?? "",
        finishReason: primaryForEvidence?.finishReason ?? "not-requested",
        edit: applied?.edit ?? null,
        appliedText: applied?.appliedText ?? null,
        firstUsableMs: null,
        sourceUsableMs: getSourceUsableMs() ?? (applied ? completeMs : null),
        completeMs,
        grpcMs: counters.grpcMs,
        classification,
        ...(failure ? { review: `ApiClient invocation error: ${failure}` } : {}),
        semanticReview:
          "Unreviewed: any returned source-level result is applied to the synthetic document; editor presentation and semantic correctness were not assessed.",
        events,
        rpcEvidence: rpcRecords,
        intermediateResults: getIntermediateResults(),
        apiLogEvidence: state.loggerEvents,
        completionServerEvidence: counters,
        cacheEvidence: JSON.stringify({
          apiIdenticalPromptCacheEnabled: apiResultsCacheEnabled,
          apiIdenticalPromptCacheHitObserved: cacheHit,
          cacheSourceStep: cacheHit ? lastSuccessfulPrimary.step : null,
          grpcCalls: rpcRecords.length,
          serverModelOrPrefixCache: "unobservable and uncontrolled",
        }),
        pathEvidence: `${sourceRootForSequence} (${referenceIdentity}) -> production ApiClient.getAutocomplete -> production prompt/retrieval/rules/cache/response pipeline -> sequence-scoped CompletionServer seam and CompletionClient -> synthetic VS Code/workspace/LSP; no editor presentation; older managed-runtime/Python parity is not established`,
        ...(primaryForEvidence
          ? {
              primaryRequestContext: {
                model: primaryForEvidence.model,
                startedAtMs: primaryRpc?.startedAtMs ?? primaryForEvidence.startedAtMs,
                firstTokenAtMs: primaryRpc?.firstTokenAtMs ?? primaryForEvidence.firstTokenAtMs,
                ...(cacheHit ? { reusedFromStep: lastSuccessfulPrimary.step } : {}),
              },
            }
          : {}),
      });

      if (primaryRpc && !primaryRpc.error) {
        lastSuccessfulPrimary = { rpc: primaryRpc, step: stepIndex };
      }
    }
  } finally {
    api.dispose?.();
    client.dispose();
  }

  const conditionEvidence = {
    requested: message.sequence.cache,
    achieved: false,
    reason:
      "Adapter neither starts nor inspects the external model server; cold/warm model and server prompt-cache conditions are not established.",
    adapterProcessPid: process.pid,
    sourceRoot: sourceRootForSequence,
    socketPath,
    workspaceRoot: workspaceBase,
    apiIdenticalPromptCacheEnabled: apiResultsCacheEnabled,
    sequenceLifetimeEvidence: {
      apiClientInstances: 1,
      completionClientInstances: 1,
      fixtureDocumentInstances: caseStates.size,
      steps: message.sequence.steps.length,
      documentVersions: [...caseStates].map(([id, entry]) => ({
        id,
        version: entry.document.version,
      })),
      connectionAndApiCachePersistAcrossSteps: true,
    },
    limitations: [
      "VS Code documents, LSP definition/reference providers, and workspace configuration are synthetic; ApiClient orchestration itself is production code.",
      "Only ApiClient callback/return availability is timed; actual inline editor presentation timing is unknown.",
      "Semantic quality is not graded by applying the edit; it requires independent review against fixture intent.",
      "The reference JavaScript bundle was shown equivalent to the installed bundle after normalizing Rollup build-root labels; the older managed runtime/Python bundle is not covered.",
    ],
  };
  for (const result of observations) writeJson(result);
  writeJson({ type: "done", conditionEvidence });
}

await mkdir(workspaceBase, { recursive: true });
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
try {
  for await (const line of lines) {
    if (!line.trim()) continue;
    await runSequence(JSON.parse(line), sourceRoot);
    break;
  }
} finally {
  // Remove only case-specific roots verified absent and created by this process.
  for (const caseRoot of ownedCaseRoots) await rm(caseRoot, { recursive: true, force: true });
}
