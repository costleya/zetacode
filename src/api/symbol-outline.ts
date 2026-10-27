import * as vscode from "vscode";

export interface SymbolOutlineOptions {
  enabled?: boolean;
  maxCharacters?: number;
  maxEntries?: number;
  timeoutMs?: number;
  retryBackoffMs?: number;
  documentSymbolLoader?: DocumentSymbolLoader;
}

export type DocumentSymbolLoader = (
  uri: vscode.Uri,
) => Thenable<(vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined>;

interface OutlineSymbol {
  name: string;
  kind: string;
  line: number;
  start: vscode.Position;
  end: vscode.Position;
  detail?: string;
}

interface CachedOutline {
  version: number;
  symbols: OutlineSymbol[];
  lastAttempt: number;
  retryAfter: number;
  timedOut: boolean;
}

const DEFAULT_MAX_ENTRIES = 16;
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_RETRY_BACKOFF_MS = 30_000;
const DEFAULT_MAX_CHARACTERS = 1_200;
const MAX_RENDERED_SYMBOLS = 8;

/**
 * Maintains a small, per-document symbol cache. Calls to getOutline never wait
 * for the language server; they return the last usable outline and refresh it
 * in the background when the document version changes.
 */
export class SymbolOutlineProvider {
  private readonly cache = new Map<string, CachedOutline>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly enabled: boolean;
  private readonly maxEntries: number;
  private readonly timeoutMs: number;
  private readonly retryBackoffMs: number;
  private readonly documentSymbolLoader: DocumentSymbolLoader;
  private disposed = false;

  constructor(options: SymbolOutlineOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.retryBackoffMs = positiveInteger(options.retryBackoffMs, DEFAULT_RETRY_BACKOFF_MS);
    this.documentSymbolLoader =
      options.documentSymbolLoader ??
      ((uri) =>
        vscode.commands.executeCommand<
          (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined
        >("vscode.executeDocumentSymbolProvider", uri));
  }

  /** Return cached context immediately, scheduling provider work if needed. */
  getOutline(
    document: vscode.TextDocument,
    position: vscode.Position,
    maxCharacters = DEFAULT_MAX_CHARACTERS,
  ): string {
    if (!this.enabled || this.disposed) return "";

    const uri = document.uri.toString();
    const cached = this.touch(uri);
    if (!cached || cached.version !== document.version) {
      void this.beginRefresh(document);
    }
    return renderOutline(cached?.symbols ?? [], position, Math.max(0, Math.floor(maxCharacters)));
  }

  /** Refresh on demand, for example from a document-save handler. */
  async refresh(document: vscode.TextDocument): Promise<void> {
    if (!this.enabled || this.disposed) return;
    const request = this.beginRefresh(document);
    if (!request) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        request.then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.cache.clear();
  }

  private beginRefresh(document: vscode.TextDocument): Promise<unknown> | undefined {
    const uri = document.uri.toString();
    const existing = this.pending.get(uri);
    if (existing) return existing;

    const cached = this.touch(uri);
    const now = Date.now();
    if (cached && cached.retryAfter > now) return undefined;
    if (this.pending.size >= this.maxEntries) return undefined;

    const requestedVersion = document.version;
    const entry: CachedOutline = cached ?? {
      version: -1,
      symbols: [],
      lastAttempt: 0,
      retryAfter: 0,
      timedOut: false,
    };
    entry.lastAttempt = now;
    entry.timedOut = false;
    this.cache.set(uri, entry);
    this.evictOverflow(uri);

    const request = Promise.resolve().then(() => this.documentSymbolLoader(document.uri));
    this.pending.set(uri, request);

    const timeout = setTimeout(() => {
      const current = this.cache.get(uri);
      if (current?.lastAttempt !== now) return;
      current.timedOut = true;
      current.retryAfter = Date.now() + this.retryBackoffMs;
    }, this.timeoutMs);
    this.timers.set(uri, timeout);

    void request
      .then((symbols) => {
        const current = this.cache.get(uri);
        if (
          this.disposed ||
          !current ||
          current.lastAttempt !== now ||
          current.timedOut ||
          document.version !== requestedVersion
        ) {
          return;
        }
        current.version = requestedVersion;
        current.symbols = normalizeSymbols(symbols ?? [], document.uri);
        current.retryAfter = 0;
      })
      .catch(() => {
        const current = this.cache.get(uri);
        if (current?.lastAttempt === now) {
          current.retryAfter = Date.now() + this.retryBackoffMs;
        }
      })
      .finally(() => {
        clearTimeout(timeout);
        if (this.timers.get(uri) === timeout) this.timers.delete(uri);
        if (this.pending.get(uri) === request) this.pending.delete(uri);
      });

    return request;
  }

  private touch(uri: string): CachedOutline | undefined {
    const entry = this.cache.get(uri);
    if (entry) {
      this.cache.delete(uri);
      this.cache.set(uri, entry);
    }
    return entry;
  }

  private evictOverflow(protectedUri: string): void {
    while (this.cache.size > this.maxEntries) {
      const victim = [...this.cache.keys()].find((uri) => uri !== protectedUri);
      if (victim === undefined) return;
      this.cache.delete(victim);
    }
  }
}

function normalizeSymbols(
  symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[],
  documentUri: vscode.Uri,
): OutlineSymbol[] {
  const result: OutlineSymbol[] = [];
  const visitDocumentSymbol = (symbol: vscode.DocumentSymbol): void => {
    result.push({
      name: cleanText(symbol.name, 100),
      kind: symbolKindName(symbol.kind),
      line: symbol.range.start.line,
      start: symbol.range.start,
      end: symbol.range.end,
      ...(symbol.detail ? { detail: cleanText(symbol.detail, 80) } : {}),
    });
    for (const child of symbol.children) visitDocumentSymbol(child);
  };

  for (const symbol of symbols) {
    if ("location" in symbol) {
      if (symbol.location.uri.toString() !== documentUri.toString()) continue;
      const range = symbol.location.range;
      result.push({
        name: cleanText(symbol.name, 100),
        kind: symbolKindName(symbol.kind),
        line: range.start.line,
        start: range.start,
        end: range.end,
        ...(symbol.containerName ? { detail: cleanText(symbol.containerName, 80) } : {}),
      });
    } else {
      visitDocumentSymbol(symbol);
    }
  }

  const seen = new Set<string>();
  return result.filter((symbol) => {
    if (!symbol.name) return false;
    const key = `${symbol.kind}\0${symbol.name}\0${symbol.line}\0${symbol.start.character}\0${symbol.end.line}\0${symbol.end.character}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderOutline(
  symbols: readonly OutlineSymbol[],
  position: vscode.Position,
  maxCharacters: number,
): string {
  if (symbols.length === 0 || maxCharacters === 0) return "";
  const containing = symbols
    .filter((symbol) => rangeContains(symbol, position))
    .sort((a, b) => spanSize(a) - spanSize(b) || a.line - b.line)[0];
  const nearby = symbols
    .filter((symbol) => symbol !== containing)
    .sort(
      (a, b) =>
        distance(a, position.line) - distance(b, position.line) ||
        a.line - b.line ||
        a.name.localeCompare(b.name),
    )
    .slice(0, Math.max(0, MAX_RENDERED_SYMBOLS - (containing ? 1 : 0)));

  const rows: string[] = [];
  if (containing) rows.push(`Current: ${describe(containing)}`);
  for (const symbol of nearby) rows.push(`Nearby: ${describe(symbol)}`);
  let output = "Symbols:\n";
  for (const row of rows) {
    const candidate = `${output}${row}\n`;
    if (candidate.length > maxCharacters) {
      if (output === "Symbols:\n" && maxCharacters > 0) {
        return candidate.slice(0, maxCharacters);
      }
      break;
    }
    output = candidate;
  }
  return output === "Symbols:\n" ? "" : output.trimEnd();
}

function describe(symbol: OutlineSymbol): string {
  const suffix = symbol.detail ? ` (${symbol.detail})` : "";
  return `${symbol.kind} ${symbol.name}${suffix} — line ${symbol.line + 1}`;
}

function rangeContains(symbol: OutlineSymbol, position: vscode.Position): boolean {
  return symbol.start.isBeforeOrEqual(position) && symbol.end.isAfterOrEqual(position);
}

function spanSize(symbol: OutlineSymbol): number {
  return (
    (symbol.end.line - symbol.start.line) * 1_000_000 +
    (symbol.end.character - symbol.start.character)
  );
}

function distance(symbol: OutlineSymbol, line: number): number {
  if (line < symbol.start.line) return symbol.start.line - line;
  if (line > symbol.end.line) return line - symbol.end.line;
  return 0;
}

function symbolKindName(kind: vscode.SymbolKind): string {
  return vscode.SymbolKind[kind]?.toLowerCase() ?? "symbol";
}

function cleanText(text: string, maxLength: number): string {
  const cleaned = text.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback;
}
