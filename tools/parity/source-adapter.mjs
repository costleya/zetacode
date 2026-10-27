#!/usr/bin/env -S node --experimental-transform-types
/**
 * Source-level parity adapter for the production Zeta prompt, gRPC client,
 * response parser and edit coordinates. It intentionally does not initialize
 * VS Code, start a server, or claim that an editor displayed the suggestion.
 *
 * Select a checkout with NES_SOURCE_ROOT and an already-running gRPC socket
 * with NES_GRPC_SOCKET. The harness launches one process per sequence.
 */
import { registerHooks } from "node:module";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { performance } from "node:perf_hooks";

const defaultRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourceRoot = path.resolve(process.env.NES_SOURCE_ROOT || defaultRoot);
const sourceUrl = pathToFileURL(`${sourceRoot}${path.sep}`);
const referenceBuild = sourceRoot === "/private/tmp/nes-rebuild-reference";
const referenceIdentity = referenceBuild
  ? "Pinned reference JS bundle 6394ca41a51f84add687630ce62a1df5fdb9f6b45164af3345d7c9e24d549a6b; bundle comparison normalized only 526 Rollup build-root labels and matched installed bundle SHA-256 2a7ebcffde057254f84001000c1d10fd61886dad56d7a63132b84092a3ea7815"
  : "Rebuilt checkout source; installed-bundle identity is not asserted by this adapter";

// The rebuilt source uses ~/ aliases, while the supplied reference source has
// the same alias convention. Resolve each against the selected checkout.
// vscode is only needed as a type/namespace by the imported parser logger;
// no VS Code APIs are called by this source-only path.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("~/")) {
      return nextResolve(new URL(`src/${specifier.slice(2)}`, sourceUrl).href, context);
    }
    if (specifier === "vscode") {
      return {
        url: "data:text/javascript,export const window = {};",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const importSource = (relativePath) => import(new URL(relativePath, sourceUrl).href);
const [promptModule, grpcModule, constantsModule, schemaModule, parserModules, offsetModule] =
  await Promise.all([
    importSource(referenceBuild ? "src/api/zeta2-prompt.ts" : "src/api/prompt.ts"),
    importSource("src/api/completion-client.ts"),
    importSource("src/core/constants.ts"),
    importSource("src/api/schemas.ts"),
    referenceBuild ? importSource("src/api/model-provider.ts") : importSource("src/api/parser.ts"),
    referenceBuild ? importSource("src/utils/text.ts") : Promise.resolve(null),
  ]);
const buildPrompt = referenceBuild ? promptModule.buildZeta2Prompt : promptModule.buildZetaPrompt;
const completionClient = grpcModule.CompletionClient;
const parseOrBuildResponse = referenceBuild
  ? parserModules.getModelProvider(constantsModule.MODEL_NAME).buildResponse
  : parserModules.parseZetaResponse;
const byteOffsetToUtf16 = referenceBuild ? offsetModule.utf8ByteOffsetToUtf16Offset : undefined;

const socketPath = process.env.NES_GRPC_SOCKET;
if (!socketPath) {
  throw new Error("Set NES_GRPC_SOCKET to an already-running production gRPC Unix socket");
}

const client = new completionClient({ socketPath });
const now = () => performance.now();
const jsonLine = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const stderr = (message) => process.stderr.write(`${message}\n`);

function cursorFixture(testCase, step) {
  const insertion = typeof step.insert === "string" ? step.insert : "";
  const anchor = testCase.cursorAfter;
  const anchorIndex = testCase.text.lastIndexOf(anchor);
  if (anchorIndex < 0) throw new Error(`${testCase.id}: cursorAfter is not in text`);
  const cursorIndex = anchorIndex + anchor.length;
  const text = `${testCase.text.slice(0, cursorIndex)}${insertion}${testCase.text.slice(cursorIndex)}`;
  const cursorUtf16 = cursorIndex + insertion.length;
  return {
    text,
    cursorPosition: Buffer.byteLength(text.slice(0, cursorUtf16), "utf8"),
  };
}

function buildRequest(testCase, text, cursorPosition) {
  const diagnostics = (testCase.diagnostics ?? []).map((diagnostic) => ({
    line: diagnostic.line,
    start_offset: 0,
    end_offset: 0,
    severity: diagnostic.severity,
    message: diagnostic.message,
    timestamp: 0,
  }));
  const retrievalChunks = (testCase.related ?? []).map((chunk) => ({
    file_path: chunk.path,
    start_line: 0,
    end_line: chunk.text.split("\n").length,
    content: chunk.text,
  }));
  const request = {
    debug_info: "parity source adapter",
    repo_name: "parity-fixture",
    file_path: testCase.path,
    file_contents: text,
    original_file_contents: testCase.text,
    cursor_position: cursorPosition,
    recent_changes: "",
    symbol_outline: "",
    changes_above_cursor: true,
    multiple_suggestions: true,
    file_chunks: [],
    retrieval_chunks: retrievalChunks,
    editor_diagnostics: diagnostics,
    recent_user_actions: [],
    use_bytes: true,
  };
  const validated = schemaModule.AutocompleteRequestSchema.safeParse(request);
  if (!validated.success) {
    throw new Error(`${testCase.id}: invalid adapter request: ${validated.error.message}`);
  }
  return validated.data;
}

function buildProductionPrompt(request, testCase) {
  const rules = testCase.rules ?? "";
  if (referenceBuild) {
    return buildPrompt(request, { rules });
  }
  const prompt = buildPrompt(request, { workspaceRules: rules });
  if (!prompt) throw new Error(`${testCase.id}: production prompt builder returned no prompt`);
  return prompt;
}

function mapEdit(completion, prompt, finishReason) {
  if (referenceBuild) {
    const responses = parseOrBuildResponse(
      { text: completion, finishReason },
      prompt,
      "parity-source-adapter",
    );
    const response = responses?.[0];
    if (!response) return null;
    const source = prompt.lines.map((line) => line.content).join("\n");
    const start = byteOffsetToUtf16(source, response.start_index);
    const end = byteOffsetToUtf16(source, response.end_index);
    return { start, end, text: response.completion };
  }

  const result = parseOrBuildResponse(
    {
      autocomplete_id: "parity-source-adapter",
      start_index: 0,
      end_index: 0,
      completion,
      confidence: 1,
      finish_reason: finishReason,
    },
    prompt,
  );
  return result
    ? { start: result.startIndex, end: result.endIndex, text: result.completion }
    : null;
}

function applyEdit(text, edit) {
  if (!edit || edit.start < 0 || edit.end < edit.start || edit.end > text.length) return null;
  return `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`;
}

function promptOptionsEvidence() {
  return referenceBuild
    ? "production buildZeta2Prompt defaults plus fixture workspace rules"
    : "production buildZetaPrompt defaults plus fixture workspace rules";
}

async function runSequence(message) {
  if (message?.type !== "sequence" || !message.sequence || !Array.isArray(message.sequence.steps)) {
    throw new Error("Expected one sequence message from tools/parity/run.mjs");
  }
  const byId = new Map(message.cases.map((testCase) => [testCase.id, testCase]));
  const observations = [];

  for (let stepIndex = 0; stepIndex < message.sequence.steps.length; stepIndex += 1) {
    const step = message.sequence.steps[stepIndex];
    const testCase = byId.get(step.case);
    if (!testCase) throw new Error(`Unknown parity case: ${step.case}`);
    const started = now();
    const events = [{ type: "source_request_started", atMs: 0 }];
    let prompt = "";
    let generated = "";
    let finishReason = "unavailable";
    let grpcMs = 0;
    let edit = null;
    let appliedText = null;
    let classification = "error";
    let sourceUsableMs = null;
    let sourceResultMs = null;
    let failure = "";

    try {
      const fixture = cursorFixture(testCase, step);
      const request = buildRequest(testCase, fixture.text, fixture.cursorPosition);
      const productionPrompt = buildProductionPrompt(request, testCase);
      prompt = productionPrompt.prompt;
      events.push({ type: "production_prompt_built", atMs: now() - started });

      const grpcStarted = now();
      events.push({ type: "grpc_request_started", atMs: grpcStarted - started });
      const response = await client.complete({
        model: constantsModule.MODEL_NAME,
        prompt,
        temperature: constantsModule.TEMPERATURE,
        maxTokens: constantsModule.MAX_TOKENS,
        stop: productionPrompt.stopTokens,
        timeoutMs: Number(process.env.NES_COMPLETION_TIMEOUT_MS || 30_000),
        onFirstToken: () => events.push({ type: "grpc_first_token", atMs: now() - started }),
      });
      grpcMs = now() - grpcStarted;
      generated = response.text;
      finishReason = response.finishReason;
      events.push({ type: "grpc_final_result", atMs: now() - started });

      edit = mapEdit(generated, productionPrompt, finishReason);
      appliedText = applyEdit(fixture.text, edit);
      sourceResultMs = now() - started;
      if (appliedText !== null) sourceUsableMs = sourceResultMs;
      classification = appliedText === null ? "no-edit" : "usable";
      events.push({
        type: appliedText === null ? "source_no_applicable_edit" : "source_edit_applied",
        atMs: sourceResultMs,
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      grpcMs = Math.max(
        grpcMs,
        events.some((event) => event.type === "grpc_request_started")
          ? now() - (started + events.find((event) => event.type === "grpc_request_started").atMs)
          : 0,
      );
      events.push({ type: "source_error", atMs: now() - started, message: failure });
      stderr(`${message.sequence.id}/${stepIndex}: ${failure}`);
    }

    observations.push({
      type: "result",
      step: stepIndex,
      prompt,
      generated,
      finishReason,
      edit,
      appliedText,
      // Source-level parsed-and-applied timing. No extension host/editor is
      // present, so actual suggestion presentation is deliberately unknown.
      firstUsableMs: null,
      sourceUsableMs,
      sourceResultMs,
      completeMs: now() - started,
      grpcMs,
      classification,
      ...(failure ? { review: `Adapter execution error: ${failure}` } : {}),
      qualityEvidence:
        classification === "usable"
          ? "Operational source-level status only: parser produced an applicable edit and synthetic application succeeded; semantic correctness is unreviewed."
          : "Semantic correctness is unreviewed.",
      events,
      cacheEvidence:
        "ApiClient result cache is bypassed by the direct production prompt/parser path; external server model/prompt cache state is unobservable and uncontrolled",
      pathEvidence: `${sourceRoot} (${referenceIdentity}): ${promptOptionsEvidence()} -> production CompletionClient.complete (gRPC Unix socket) -> ${referenceBuild ? "production Zeta provider buildResponse" : "production parseZetaResponse"} -> UTF-16 edit applied to synthetic fixture; source-level only, no editor presentation; older managed-runtime/Python parity is not established`,
    });
  }

  const conditionEvidence = {
    requested: message.sequence.cache,
    achieved: false,
    reason:
      "Adapter does not start, reset, or inspect the external model server; cold/warm model and server prompt-cache conditions are not established.",
    adapterProcessPid: process.pid,
    sourceRoot,
    socketPath,
    promptBuilderDefaults: promptOptionsEvidence(),
    referenceIdentity,
    limitations: [
      "Prompt builder receives a synthetic request assembled from the frozen corpus; full ApiClient retrieval, workspace-rule loading, and editor orchestration are not exercised.",
      "Only source parsed-and-applied timing is measured; editor presentation timing remains unknown.",
      "The reference JavaScript bundle was shown equivalent to the installed bundle after normalizing Rollup build-root labels; the older managed runtime/Python bundle is not covered.",
    ],
  };
  for (const result of observations) jsonLine(result);
  jsonLine({ type: "done", conditionEvidence });
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  await runSequence(JSON.parse(line));
  break;
}
client.dispose();
