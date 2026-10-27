import * as vscode from "vscode";

const DEFAULT_WARNING_CHARACTERS = 3_000;
const FAILED_READ_CACHE_MS = 5_000;

interface CommentStyle {
  prefix: string;
  suffix?: string;
}

const COMMENT_STYLES: Readonly<Record<string, CommentStyle>> = {
  bat: { prefix: "REM" },
  c: { prefix: "//" },
  cpp: { prefix: "//" },
  csharp: { prefix: "//" },
  css: { prefix: "/*", suffix: "*/" },
  go: { prefix: "//" },
  groovy: { prefix: "//" },
  handlebars: { prefix: "{{!--", suffix: "--}}" },
  html: { prefix: "<!--", suffix: "-->" },
  java: { prefix: "//" },
  javascript: { prefix: "//" },
  javascriptreact: { prefix: "//" },
  jsonc: { prefix: "//" },
  json5: { prefix: "//" },
  jsx: { prefix: "//" },
  kotlin: { prefix: "//" },
  less: { prefix: "//" },
  makefile: { prefix: "#" },
  markdown: { prefix: "<!--", suffix: "-->" },
  objective_c: { prefix: "//" },
  objective_cpp: { prefix: "//" },
  perl: { prefix: "#" },
  php: { prefix: "//" },
  plaintext: { prefix: "#" },
  python: { prefix: "#" },
  r: { prefix: "#" },
  ruby: { prefix: "#" },
  rust: { prefix: "//" },
  scala: { prefix: "//" },
  scss: { prefix: "//" },
  shellscript: { prefix: "#" },
  sql: { prefix: "--" },
  swift: { prefix: "//" },
  toml: { prefix: "#" },
  typescript: { prefix: "//" },
  typescriptreact: { prefix: "//" },
  vue: { prefix: "<!--", suffix: "-->" },
  xml: { prefix: "<!--", suffix: "-->" },
  yaml: { prefix: "#" },
};

export function getCommentPrefix(languageId: string): string | undefined {
  return COMMENT_STYLES[languageId]?.prefix;
}

interface RulesCacheEntry {
  mtime?: number;
  content: string;
  retryAfter?: number;
}

const rulesCache = new Map<string, RulesCacheEntry>();

export interface WorkspaceRulesOptions {
  maxWarningCharacters?: number;
  onWarning?: (message: string) => void;
}

/** Return the workspace rules URI when the document supports workspace rules. */
export function rulesPath(document: vscode.TextDocument): vscode.Uri | undefined {
  if (!COMMENT_STYLES[document.languageId]) return undefined;
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) return undefined;
  return vscode.Uri.joinPath(workspaceFolder.uri, ".vscode", `nes-${document.languageId}.md`);
}

/** Load and comment a workspace-local `.vscode/nes-<languageId>.md` rules file. */
export async function loadWorkspaceRules(
  document: vscode.TextDocument,
  options: WorkspaceRulesOptions = {},
): Promise<string> {
  const style = COMMENT_STYLES[document.languageId];
  if (!style) return "";

  const rulesUri = rulesPath(document);
  if (!rulesUri) return "";
  const cacheKey = rulesUri.toString();
  const now = Date.now();
  const cached = rulesCache.get(cacheKey);
  if (cached?.retryAfter !== undefined && cached.retryAfter > now) {
    return cached.content;
  }

  try {
    const stat = await vscode.workspace.fs.stat(rulesUri);
    if (cached?.mtime === stat.mtime) return cached.content;

    const raw = new TextDecoder("utf-8").decode(await vscode.workspace.fs.readFile(rulesUri));
    const trimmed = raw.trim();
    if (!trimmed) {
      rulesCache.set(cacheKey, { mtime: stat.mtime, content: "" });
      return "";
    }

    const maxCharacters = options.maxWarningCharacters ?? DEFAULT_WARNING_CHARACTERS;
    if (trimmed.length > maxCharacters) {
      const message = `Workspace rules at ${rulesUri.fsPath} contain ${trimmed.length} characters (configured warning limit: ${maxCharacters}).`;
      if (options.onWarning) options.onWarning(message);
      else console.warn(message);
    }

    const content = trimmed
      .split(/\r?\n/)
      .map((line) => formatCommentLine(line, style))
      .join("\n");
    const rendered = `${content}\n`;
    rulesCache.set(cacheKey, { mtime: stat.mtime, content: rendered });
    return rendered;
  } catch {
    rulesCache.set(cacheKey, {
      content: "",
      retryAfter: now + FAILED_READ_CACHE_MS,
    });
    return "";
  }
}

function formatCommentLine(line: string, style: CommentStyle): string {
  const value = line.trim();
  if (style.suffix) {
    return value ? `${style.prefix} ${value} ${style.suffix}` : `${style.prefix} ${style.suffix}`;
  }
  return value ? `${style.prefix} ${value}` : style.prefix;
}
