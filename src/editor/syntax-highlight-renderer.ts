import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { HighlighterCore } from "@shikijs/core";
import type { ThemeRegistrationAny } from "@shikijs/types";
import type { IRawThemeSetting } from "@shikijs/vscode-textmate";
import * as vscode from "vscode";
import { z } from "zod";

/** VS Code languageId → shiki grammar name (only where they differ) */
const LANGUAGE_MAP: Record<string, string> = {
  javascriptreact: "jsx",
  typescriptreact: "tsx",
};

function resolveLanguageId(vscodeLanguageId: string): string {
  return LANGUAGE_MAP[vscodeLanguageId] ?? vscodeLanguageId;
}

// ── Highlighter singleton ──────────────────────────────────────────────

const FALLBACK_FG_DARK = "#D4D4D4";
const FALLBACK_FG_LIGHT = "#000000";
const USER_THEME_NAME = "user-theme";

const themeContributionSchema = z.object({
  label: z.string().optional(),
  id: z.string().optional(),
  uiTheme: z.string().optional(),
  path: z.string().optional(),
});

const themeTokenColorSettingsSchema = z.object({
  foreground: z.string().optional(),
  background: z.string().optional(),
  fontStyle: z.string().optional(),
});

const themeTokenColorSchema = z.object({
  name: z.string().optional(),
  scope: z.union([z.string(), z.array(z.string())]).optional(),
  settings: themeTokenColorSettingsSchema.optional(),
});

const themeSemanticTokenSettingsSchema = z.object({
  foreground: z.string().optional(),
  fontStyle: z.string().optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
});

const themeJsonSchema = z.object({
  include: z.string().optional(),
  colors: z.record(z.string(), z.string()).optional(),
  tokenColors: z.array(themeTokenColorSchema).optional(),
  semanticHighlighting: z.boolean().optional(),
  semanticTokenColors: z
    .record(z.string(), z.union([z.string(), themeSemanticTokenSettingsSchema]))
    .optional(),
});

type ThemeJson = z.infer<typeof themeJsonSchema>;
type ThemeSemanticTokenSettings = z.infer<typeof themeSemanticTokenSettingsSchema>;

type ShikiThemeInput = ThemeRegistrationAny;

let highlighter: HighlighterCore | null = null;
let highlighterPromise: Promise<HighlighterCore | null> | null = null;

function isThemeSemanticTokenSettings(value: unknown): value is ThemeSemanticTokenSettings {
  return themeSemanticTokenSettingsSchema.safeParse(value).success;
}

/**
 * Discovers and reads the user's active VS Code color theme file.
 * Returns the parsed theme JSON if found, or null.
 *
 * VS Code stores a theme identifier in `workbench.colorTheme`. This can be:
 * - The explicit `id` from the extension's `contributes.themes`
 * - The `label` (for many third-party themes)
 * - An auto-generated ID: `${extensionId}-${path-stem}` (when no explicit id)
 */
function discoverActiveTheme(): ThemeJson | null {
  try {
    const themeSetting = vscode.workspace.getConfiguration("workbench").get<string>("colorTheme");
    if (!themeSetting) return null;

    const settingLower = themeSetting.toLowerCase();

    for (const ext of vscode.extensions.all) {
      const themesResult = z
        .array(themeContributionSchema)
        .safeParse(ext.packageJSON?.contributes?.themes);
      if (!themesResult.success) continue;
      const themes = themesResult.data;

      for (const themeEntry of themes) {
        if (!themeEntry.path) continue;

        // Match against explicit id, label, or the auto-generated ID
        // that VS Code constructs as `${extensionId}-${path-stem}`
        const candidates: string[] = [];
        if (themeEntry.id) candidates.push(themeEntry.id);
        if (themeEntry.label) candidates.push(themeEntry.label);

        // VS Code generates the ID from extension ID + path stem when
        // no explicit id is provided. e.g. for a built-in theme at
        // "./themes/dark_plus.json" in extension "vscode.theme-defaults",
        // the generated ID might be "Default Dark+".
        const pathStem = path.basename(themeEntry.path, path.extname(themeEntry.path));
        candidates.push(`${ext.id}-${pathStem}`);

        const matched = candidates.some((c) => c.toLowerCase() === settingLower);
        if (!matched) continue;

        const themePath = path.join(ext.extensionPath, themeEntry.path);
        const result = resolveThemeFile(themePath);
        if (result) {
          console.log("[Sweep] Discovered active theme:", themeSetting, "from", ext.id);
          return result;
        }
      }
    }

    console.warn("[Sweep] Could not find theme file for:", themeSetting);
  } catch (err) {
    console.warn("[Sweep] Failed to discover active theme:", err);
  }
  return null;
}

function stripJsonComments(raw: string): string {
  let result = "";
  let i = 0;
  let inString = false;

  while (i < raw.length) {
    const char = raw[i];
    const next = raw[i + 1];

    if (inString) {
      result += char;
      if (char === "\\" && i + 1 < raw.length) {
        result += raw[i + 1];
        i += 2;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      i++;
      continue;
    }

    if (char === "/" && next === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
      continue;
    }

    if (char === "/" && next === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) {
        i++;
      }
      i += 2; // Skip closing */
      continue;
    }

    result += char;
    i++;
  }

  return result;
}

function parseJsonc(raw: string): unknown {
  const stripped = stripJsonComments(raw);
  const cleaned = stripped.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(cleaned);
}

function parseThemeJson(raw: string): ThemeJson | null {
  const parsed = parseJsonc(raw);
  const result = themeJsonSchema.safeParse(parsed);
  if (!result.success) return null;
  return result.data;
}

function resolveThemeFile(themePath: string): ThemeJson | null {
  try {
    const raw = fs.readFileSync(themePath, "utf8");
    const theme = parseThemeJson(raw);
    if (!theme) return null;

    if (typeof theme.include === "string") {
      const parentPath = path.resolve(path.dirname(themePath), theme.include);
      const parent = resolveThemeFile(parentPath);
      if (parent) {
        const parentTokenColors = parent.tokenColors ?? [];
        const childTokenColors = theme.tokenColors ?? [];
        const parentColors = parent.colors ?? {};
        const childColors = theme.colors ?? {};

        return {
          ...parent,
          ...theme,
          tokenColors: [...parentTokenColors, ...childTokenColors],
          colors: { ...parentColors, ...childColors },
        };
      }
    }

    return theme;
  } catch (err) {
    console.warn("[Sweep] Failed to read theme file:", themePath, err);
    return null;
  }
}

function buildShikiTheme(themeJson: ThemeJson, isDark: boolean): ThemeRegistrationAny {
  const tokenColors: IRawThemeSetting[] = themeJson.tokenColors
    ? themeJson.tokenColors.map((token) => {
        const settings: IRawThemeSetting["settings"] = {
          ...(token.settings?.foreground !== undefined
            ? { foreground: token.settings.foreground }
            : {}),
          ...(token.settings?.background !== undefined
            ? { background: token.settings.background }
            : {}),
          ...(token.settings?.fontStyle !== undefined
            ? { fontStyle: token.settings.fontStyle }
            : {}),
        };
        return {
          settings,
          ...(token.name !== undefined ? { name: token.name } : {}),
          ...(token.scope !== undefined ? { scope: token.scope } : {}),
        };
      })
    : [];

  const semanticTokenColors: Record<string, string> = {};
  if (themeJson.semanticTokenColors) {
    for (const [key, value] of Object.entries(themeJson.semanticTokenColors)) {
      if (typeof value === "string") {
        semanticTokenColors[key] = value;
      } else if (isThemeSemanticTokenSettings(value) && typeof value.foreground === "string") {
        semanticTokenColors[key] = value.foreground;
      }
    }
  }

  const theme: ThemeRegistrationAny = {
    name: USER_THEME_NAME,
    type: isDark ? "dark" : "light",
    settings: tokenColors,
  };
  if (themeJson.colors) {
    theme.colors = themeJson.colors;
  }
  if (tokenColors.length > 0) {
    theme.tokenColors = tokenColors;
  }
  if (themeJson.semanticHighlighting !== undefined) {
    theme.semanticHighlighting = themeJson.semanticHighlighting;
  }
  if (Object.keys(semanticTokenColors).length > 0) {
    theme.semanticTokenColors = semanticTokenColors;
  }
  return theme;
}

let cachedThemeSetting: string | null = null;
let cachedThemeJson: ThemeJson | null = null;
let cachedEditorBackground: string | null = null;
let themeVersion = 0;

function resetThemeCache(): void {
  cachedThemeSetting = null;
  cachedThemeJson = null;
  cachedEditorBackground = null;
}

function getActiveThemeSetting(): string | null {
  return vscode.workspace.getConfiguration("workbench").get<string>("colorTheme") ?? null;
}

function getCachedThemeJson(): ThemeJson | null {
  const currentSetting = getActiveThemeSetting();
  if (currentSetting && cachedThemeSetting === currentSetting && cachedThemeJson) {
    return cachedThemeJson;
  }
  cachedThemeSetting = currentSetting;
  cachedThemeJson = discoverActiveTheme();
  cachedEditorBackground = null;
  return cachedThemeJson;
}

function getEditorBackgroundColor(isDark: boolean): string {
  if (cachedEditorBackground) return cachedEditorBackground;
  const themeJson = getCachedThemeJson();
  const themeColors = themeJson?.colors ?? {};
  const editorBg = themeColors["editor.background"];
  if (typeof editorBg === "string" && editorBg.length > 0) {
    cachedEditorBackground = editorBg;
    return editorBg;
  }
  const fallback = isDark ? "#1e1e1e" : "#ffffff";
  cachedEditorBackground = fallback;
  return fallback;
}

async function getHighlighter(): Promise<HighlighterCore | null> {
  if (highlighter) return highlighter;
  if (highlighterPromise) return highlighterPromise;
  const requestedThemeVersion = themeVersion;
  highlighterPromise = Promise.all([
    import("@shikijs/core"),
    import("@shikijs/engine-javascript"),
    import("@shikijs/langs/c"),
    import("@shikijs/langs/cpp"),
    import("@shikijs/langs/csharp"),
    import("@shikijs/langs/css"),
    import("@shikijs/langs/go"),
    import("@shikijs/langs/html"),
    import("@shikijs/langs/java"),
    import("@shikijs/langs/javascript"),
    import("@shikijs/langs/json"),
    import("@shikijs/langs/jsx"),
    import("@shikijs/langs/kotlin"),
    import("@shikijs/langs/markdown"),
    import("@shikijs/langs/php"),
    import("@shikijs/langs/python"),
    import("@shikijs/langs/ruby"),
    import("@shikijs/langs/rust"),
    import("@shikijs/langs/shellscript"),
    import("@shikijs/langs/swift"),
    import("@shikijs/langs/toml"),
    import("@shikijs/langs/typescript"),
    import("@shikijs/langs/tsx"),
    import("@shikijs/langs/yaml"),
    import("@shikijs/themes/dark-plus"),
    import("@shikijs/themes/light-plus"),
  ])
    .then((modules) => {
      if (requestedThemeVersion !== themeVersion) return null;
      const [core, engine, ...languageAndThemeModules] = modules;
      if (!core || !engine) return null;
      const themeModules = languageAndThemeModules.slice(-2);
      const languageModules = languageAndThemeModules.slice(0, -2);
      const langs = languageModules.flatMap((module) => (module as { default: unknown[] }).default);
      const darkPlusTheme = themeModules[0]?.default as unknown as ShikiThemeInput | undefined;
      const lightPlusTheme = themeModules[1]?.default as unknown as ShikiThemeInput | undefined;
      if (!darkPlusTheme || !lightPlusTheme) return null;

      const dark = isDarkTheme();
      const themeJson = getCachedThemeJson();
      const themes: ShikiThemeInput[] = [darkPlusTheme, lightPlusTheme];
      if (themeJson) themes.push(buildShikiTheme(themeJson, dark));
      const highlighterOptions: Parameters<typeof core.createHighlighterCoreSync>[0] = {
        themes: themes as NonNullable<
          Parameters<typeof core.createHighlighterCoreSync>[0]["themes"]
        >,
        langs: langs as NonNullable<Parameters<typeof core.createHighlighterCoreSync>[0]["langs"]>,
        engine: engine.createJavaScriptRegexEngine(),
      };
      const created = core.createHighlighterCoreSync(highlighterOptions);
      highlighter = created;
      return created;
    })
    .catch(() => null);
  return highlighterPromise ?? Promise.resolve(null);
}

/** Kept as an activation hook; Shiki is loaded only when a preview needs it. */
export function initSyntaxHighlighter(): void {
  // Deliberately lazy.
}

export function reloadTheme(): void {
  resetThemeCache();
  themeVersion += 1;
  highlighter = null;
  highlighterPromise = null;
  clearSvgCache();
}

interface ColoredToken {
  content: string;
  color?: string;
  fontStyle?: number;
}

interface FullSyntaxHighlighting {
  tokens: { length: number; foreground: number; fontStyle: number }[];
  colorMap: string[];
}

type SyntaxHighlightingLanguages = typeof vscode.languages & {
  computeFullSyntaxHighlighting?: (
    source: string,
    languageId: string,
  ) => Thenable<FullSyntaxHighlighting>;
  onDidChangeSyntaxHighlighting?: vscode.Event<void>;
};

function isCssColor(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const color = value.trim();
  return (
    /^#[\da-f]{3,8}$/i.test(color) ||
    /^rgba?\(\s*[\d.%]+\s*,\s*[\d.%]+\s*,\s*[\d.%]+(?:\s*,\s*[\d.%]+)?\s*\)$/i.test(color) ||
    /^hsla?\(\s*[\d.%]+\s*,\s*[\d.%]+\s*,\s*[\d.%]+(?:\s*,\s*[\d.%]+)?\s*\)$/i.test(color)
  );
}

export function onDidChangeSyntaxHighlighting(listener: () => void): vscode.Disposable {
  try {
    return (
      (vscode.languages as SyntaxHighlightingLanguages).onDidChangeSyntaxHighlighting?.(
        listener,
      ) ?? { dispose() {} }
    );
  } catch {
    return { dispose() {} };
  }
}

interface EditorFontSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  ligatures: boolean;
  tabSize: number;
}

function getEditorFontSettings(): EditorFontSettings {
  const editorConfig = vscode.workspace.getConfiguration("editor");
  const fontFamily = editorConfig.get<string>("fontFamily", "monospace");
  const fontSize = editorConfig.get<number>("fontSize", 13);
  const lineHeight = editorConfig.get<number>("lineHeight", 0);
  const ligaturesRaw = editorConfig.get<boolean | string>("fontLigatures", false);
  const ligatures = typeof ligaturesRaw === "string" ? ligaturesRaw.length > 0 : ligaturesRaw;
  const editorTabSize = vscode.window.activeTextEditor?.options.tabSize;
  const tabSize = editorConfig.get<number>(
    "tabSize",
    typeof editorTabSize === "number" ? editorTabSize : 4,
  );

  return { fontFamily, fontSize, lineHeight, ligatures, tabSize };
}

function expandTabs(text: string, tabSize: number): { expanded: string; indexMap: number[] } {
  let column = 0;
  const indexMap = Array.from({ length: text.length + 1 }, () => 0);
  let expanded = "";

  for (let i = 0; i < text.length; i++) {
    indexMap[i] = expanded.length;
    const ch = text[i];
    if (ch === "\t") {
      const spaces = tabSize - (column % tabSize || 0);
      expanded += " ".repeat(spaces);
      column += spaces;
    } else {
      expanded += ch;
      column += 1;
    }
  }
  indexMap[text.length] = expanded.length;
  return { expanded, indexMap };
}

async function tokenizeWithShiki(
  text: string,
  languageId: string,
  dark: boolean,
): Promise<ColoredToken[]> {
  const activeHighlighter = await getHighlighter();
  if (!activeHighlighter) {
    return [{ content: text, color: dark ? FALLBACK_FG_DARK : FALLBACK_FG_LIGHT }];
  }

  const lang = resolveLanguageId(languageId);

  const themeName = hasUserTheme() ? USER_THEME_NAME : dark ? "dark-plus" : "light-plus";

  try {
    const result = activeHighlighter.codeToTokensBase(text, {
      lang,
      theme: themeName,
    });
    const fallback = dark ? FALLBACK_FG_DARK : FALLBACK_FG_LIGHT;
    return result[0] ?? [{ content: text, color: fallback }];
  } catch {
    return [{ content: text, color: dark ? FALLBACK_FG_DARK : FALLBACK_FG_LIGHT }];
  }
}

function splitTokensIntoLines(tokens: ColoredToken[]): ColoredToken[][] {
  const lines: ColoredToken[][] = [[]];
  for (const token of tokens) {
    const parts = token.content.split("\n");
    for (let index = 0; index < parts.length; index++) {
      if (index > 0) lines.push([]);
      const content = parts[index];
      if (content) lines[lines.length - 1]?.push({ ...token, content });
    }
  }
  return lines;
}

async function tokenizeLines(
  text: string,
  languageId: string,
  dark: boolean,
): Promise<{ lines: ColoredToken[][]; native: boolean }> {
  try {
    const languages = vscode.languages as SyntaxHighlightingLanguages;
    if (languages.computeFullSyntaxHighlighting) {
      const result = await languages.computeFullSyntaxHighlighting(text, languageId);
      if (!Array.isArray(result.tokens) || !Array.isArray(result.colorMap)) {
        throw new Error("Invalid syntax highlighting result");
      }
      let offset = 0;
      const tokens = result.tokens.map((token): ColoredToken => {
        if (
          !Number.isInteger(token.length) ||
          token.length < 0 ||
          offset + token.length > text.length ||
          !Number.isInteger(token.foreground) ||
          token.foreground < 0 ||
          !Number.isInteger(token.fontStyle) ||
          token.fontStyle < 0
        ) {
          throw new Error("Invalid syntax highlighting token");
        }
        const content = text.slice(offset, offset + token.length);
        offset += token.length;
        const color = token.foreground > 0 ? result.colorMap[token.foreground] : undefined;
        if (token.foreground > 0 && !isCssColor(color)) {
          throw new Error("Missing syntax highlighting token color");
        }
        return {
          content,
          ...(color ? { color } : {}),
          fontStyle: token.fontStyle,
        };
      });
      if (offset !== text.length) {
        throw new Error("Incomplete syntax highlighting result");
      }
      return { lines: splitTokensIntoLines(tokens), native: true };
    }
  } catch {
    // Proposal access and invalid native results use the stable Shiki fallback.
  }
  const lines = text.split("\n");
  return {
    lines: await Promise.all(lines.map((line) => tokenizeWithShiki(line, languageId, dark))),
    native: false,
  };
}

function hasUserTheme(): boolean {
  if (!highlighter) return false;
  try {
    return highlighter.getLoadedThemes().includes(USER_THEME_NAME);
  } catch {
    return false;
  }
}

// ── SVG rendering ──────────────────────────────────────────────────────

let svgCacheDir: string | null = null;

function getSvgCacheDir(): string {
  if (!svgCacheDir) {
    svgCacheDir = path.join(os.tmpdir(), "sweep-nes-svg-cache");
    if (!fs.existsSync(svgCacheDir)) {
      fs.mkdirSync(svgCacheDir, { recursive: true });
    }
  }
  return svgCacheDir;
}

function clearSvgCache(): void {
  try {
    const dir = getSvgCacheDir();
    for (const file of fs.readdirSync(dir)) {
      if (file.startsWith("hl-")) {
        fs.unlinkSync(path.join(dir, file));
      }
    }
  } catch {
    // Ignore cleanup errors
  }
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function renderSyntaxHighlightedSvgFromLines(
  lines: string[],
  languageId: string,
  dark: boolean,
  highlightRangesByLine: HighlightRange[][],
  cachePrefix: string,
  themeRetry = 0,
): Promise<vscode.Uri> {
  const settings = getEditorFontSettings();
  const lineHeight =
    settings.lineHeight > 0 ? settings.lineHeight : Math.ceil(settings.fontSize * 1.35);
  const fontSize = settings.fontSize;
  const textY = Math.ceil(lineHeight - settings.fontSize * 0.25);
  const charWidth = settings.fontSize * 0.6;
  const safeLines = lines.length > 0 ? lines : [""];

  const expandedLines = safeLines.map((line) => expandTabs(line, settings.tabSize));
  const tokenizationThemeVersion = themeVersion;
  const tokenized = await tokenizeLines(
    expandedLines.map(({ expanded }) => expanded).join("\n"),
    languageId,
    dark,
  );
  if (tokenizationThemeVersion !== themeVersion) {
    if (themeRetry < 2) {
      return renderSyntaxHighlightedSvgFromLines(
        lines,
        languageId,
        isDarkTheme(),
        highlightRangesByLine,
        cachePrefix,
        themeRetry + 1,
      );
    }
    throw new Error("Syntax highlighting theme changed during render");
  }
  const tokensByLine = tokenized.lines;
  const lineWidths = expandedLines.map(({ expanded }) => expanded.length * charWidth);
  const totalWidth = Math.max(1, ...lineWidths);
  const totalHeight = lineHeight * safeLines.length;

  const rects: string[] = [];
  for (let lineIndex = 0; lineIndex < safeLines.length; lineIndex++) {
    const lineText = safeLines[lineIndex];
    if (lineText === undefined) continue;
    const ranges = highlightRangesByLine[lineIndex] ?? [];
    const expandedLine = expandedLines[lineIndex];
    if (!expandedLine) continue;
    const { indexMap } = expandedLine;
    for (const range of ranges) {
      const start = Math.max(0, Math.min(range.start, lineText.length));
      const end = Math.max(start, Math.min(range.end, lineText.length));
      if (end <= start) continue;
      const mappedStart = indexMap[start] ?? start;
      const mappedEnd = indexMap[end] ?? end;
      const x = mappedStart * charWidth;
      const width = (mappedEnd - mappedStart) * charWidth;
      const y = lineIndex * lineHeight;
      rects.push(
        `<rect x="${x}" y="${y}" width="${width}" height="${lineHeight}" rx="0" ry="0" fill="${range.color}"/>`,
      );
    }
  }

  const textElements: string[] = [];
  for (let lineIndex = 0; lineIndex < safeLines.length; lineIndex++) {
    const tokens = tokensByLine[lineIndex];
    if (!tokens || tokens.length === 0) continue;
    const tspans: string[] = [];
    for (const token of tokens) {
      const color = token.color ?? (dark ? FALLBACK_FG_DARK : FALLBACK_FG_LIGHT);
      const escapedText = escapeXml(token.content);
      const displayText = escapedText.replace(/ /g, "&#160;");
      const fontStyle = token.fontStyle ?? 0;
      const decorations: string[] = [];
      if (fontStyle & 4) decorations.push("underline");
      if (fontStyle & 8) decorations.push("line-through");
      const styles = [
        fontStyle & 1 ? 'font-style="italic"' : "",
        fontStyle & 2 ? 'font-weight="bold"' : "",
        decorations.length > 0 ? `text-decoration="${decorations.join(" ")}"` : "",
      ]
        .filter(Boolean)
        .join(" ");
      tspans.push(`<tspan fill="${escapeXml(color)}" ${styles}>${displayText}</tspan>`);
    }
    const y = lineIndex * lineHeight + textY;
    const lineWidth = lineWidths[lineIndex];
    if (lineWidth === undefined) continue;
    const textLengthAttr =
      lineWidth > 0 ? ` textLength="${lineWidth}" lengthAdjust="spacingAndGlyphs"` : "";
    textElements.push(
      `<text x="0" y="${y}" font-family="${escapeXml(
        settings.fontFamily,
      )}" font-size="${fontSize}px"${textLengthAttr}
        font-variant-ligatures="${settings.ligatures ? "normal" : "none"}"
        style="font-feature-settings: ${
          settings.ligatures ? "'liga' 1, 'calt' 1" : "'liga' 0, 'calt' 0"
        };">
    ${tspans.join("")}
  </text>`,
    );
  }

  const backgroundColor = tokenized.native ? "transparent" : getEditorBackgroundColor(dark);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${totalHeight}" width="${totalWidth}" height="${totalHeight}">
  <rect x="0" y="0" width="${totalWidth}" height="${totalHeight}" fill="${backgroundColor}"
        stroke="${dark ? "rgba(110, 110, 110, 0.35)" : "rgba(130, 130, 130, 0.35)"}" stroke-width="1"/>
  ${rects.join("")}
  ${textElements.join("")}
</svg>`;

  const themeSetting = getActiveThemeSetting() ?? "";
  const hash = createHash("sha256")
    .update(svg + languageId + themeSetting + themeVersion.toString())
    .digest("hex");
  const svgPath = path.join(getSvgCacheDir(), `${cachePrefix}-${hash}.svg`);
  fs.writeFileSync(svgPath, svg, "utf8");

  return vscode.Uri.file(svgPath);
}

export async function generateSyntaxHighlightedSvg(
  text: string,
  languageId: string,
  dark: boolean,
  highlightRanges: HighlightRange[] = [],
): Promise<vscode.Uri> {
  return renderSyntaxHighlightedSvgFromLines([text], languageId, dark, [highlightRanges], "hl");
}

export async function generateSyntaxHighlightedSvgMultiline(
  lines: string[],
  languageId: string,
  dark: boolean,
  highlightRangesByLine: HighlightRange[][] = [],
): Promise<vscode.Uri> {
  return renderSyntaxHighlightedSvgFromLines(lines, languageId, dark, highlightRangesByLine, "hlm");
}

// ── Theme detection ────────────────────────────────────────────────────

export function isDarkTheme(): boolean {
  const colorTheme = vscode.window.activeColorTheme;
  return (
    colorTheme.kind === vscode.ColorThemeKind.Dark ||
    colorTheme.kind === vscode.ColorThemeKind.HighContrast
  );
}

// ── Decoration helper ──────────────────────────────────────────────────

export interface HighlightRange {
  start: number;
  end: number;
  color: string;
}

export async function createHighlightedBoxDecoration(
  text: string,
  languageId: string,
  range: vscode.Range,
  highlightRanges: HighlightRange[] = [],
): Promise<vscode.DecorationOptions> {
  const dark = isDarkTheme();
  const svgUri = await generateSyntaxHighlightedSvg(text, languageId, dark, highlightRanges);

  return {
    range,
    renderOptions: {
      after: {
        contentIconPath: svgUri,
        textDecoration: buildBoxTextDecoration("-40%"),
      },
    },
  };
}

export async function createHighlightedBoxDecorationMultiline(
  lines: string[],
  languageId: string,
  range: vscode.Range,
  highlightRangesByLine: HighlightRange[][] = [],
): Promise<vscode.DecorationOptions> {
  const dark = isDarkTheme();
  const svgUri = await generateSyntaxHighlightedSvgMultiline(
    lines,
    languageId,
    dark,
    highlightRangesByLine,
  );
  const settings = getEditorFontSettings();
  const lineHeight =
    settings.lineHeight > 0 ? settings.lineHeight : Math.ceil(settings.fontSize * 1.35);

  return {
    range,
    renderOptions: {
      after: {
        contentIconPath: svgUri,
        textDecoration: buildBoxTextDecoration(`-${lineHeight / 2}px`),
      },
    },
  };
}

function buildBoxTextDecoration(translateY: string): string {
  return `none; position: absolute; top: 50%; transform: translateY(${translateY}); margin-left: 12px`;
}
