import * as fs from "node:fs";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import * as vscode from "vscode";

import {
  createHighlightedBoxDecoration,
  createHighlightedBoxDecorationMultiline,
  generateSyntaxHighlightedSvg,
  generateSyntaxHighlightedSvgMultiline,
  reloadTheme,
  onDidChangeSyntaxHighlighting,
} from "~/editor/syntax-highlight-renderer.ts";

const shiki = vi.hoisted(() => ({ load: vi.fn(), create: vi.fn() }));

vi.mock("@shikijs/core", async (importOriginal) => {
  shiki.load();
  const actual = await importOriginal<typeof import("@shikijs/core")>();
  shiki.create.mockImplementation(actual.createHighlighterCoreSync);
  return { ...actual, createHighlighterCoreSync: shiki.create };
});

interface Highlighting {
  tokens: { length: number; foreground: number; fontStyle: number }[];
  colorMap: string[];
}

const nativeLanguages = vscode.languages as typeof vscode.languages & {
  computeFullSyntaxHighlighting?: (source: string, languageId: string) => Promise<Highlighting>;
};

function svg(uri: vscode.Uri): string {
  return fs.readFileSync(uri.fsPath, "utf8");
}

function colored(source: string, color = "#123abc"): Highlighting {
  return {
    tokens: [{ length: source.length, foreground: 1, fontStyle: 0 }],
    colorMap: ["", color],
  };
}

beforeEach(() => {
  vi.stubGlobal("__vscodeMockConfiguration", {
    fontSize: 10,
    lineHeight: 20,
    tabSize: 4,
    fontFamily: "Test Mono",
    colorTheme: "An installed theme",
  });
  reloadTheme();
  shiki.create.mockClear();
  shiki.load.mockClear();
});

afterEach(() => {
  delete nativeLanguages.computeFullSyntaxHighlighting;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  reloadTheme();
  Reflect.deleteProperty(nativeLanguages, "onDidChangeSyntaxHighlighting");
  Reflect.set(vscode.window.activeColorTheme, "kind", vscode.ColorThemeKind.Light);
});

describe("native syntax highlighting", () => {
  test.each(["javascriptreact", "my-installed-language", "html"])(
    "passes installed language ID %s unchanged and trusts embedded language colors",
    async (languageId) => {
      const compute = vi.fn(async (source: string) => colored(source));
      nativeLanguages.computeFullSyntaxHighlighting = compute;

      const output = svg(
        await generateSyntaxHighlightedSvg("<script>let x</script>", languageId, true),
      );

      expect(compute).toHaveBeenCalledExactlyOnceWith("<script>let x</script>", languageId);
      expect(output).toContain('fill="#123abc"');
      expect(output).toContain("&lt;script&gt;let&#160;x&lt;/script&gt;");
      expect(shiki.create).not.toHaveBeenCalled();
      expect(shiki.load).not.toHaveBeenCalled();
    },
  );

  test("splits dense UTF-16 runs over newlines without losing astral characters or empty lines", async () => {
    const compute = vi.fn(async () => ({
      tokens: [
        { length: 5, foreground: 1, fontStyle: 0 },
        { length: 1, foreground: 2, fontStyle: 0 },
      ],
      colorMap: ["", "#112233", "#445566"],
    }));
    nativeLanguages.computeFullSyntaxHighlighting = compute;

    const output = svg(await generateSyntaxHighlightedSvgMultiline(["😀a", "", "z"], "html", true));

    expect(compute).toHaveBeenCalledExactlyOnceWith("😀a\n\nz", "html");
    expect(output).toContain('viewBox="0 0 18 60"');
    expect(output).toMatch(/<tspan[^>]*fill="#112233"[^>]*>😀a<\/tspan>/);
    expect(output).toMatch(/<tspan[^>]*fill="#445566"[^>]*>z<\/tspan>/);
    expect(output).not.toContain("�");
  });

  test("renders every font style bit and treats foreground zero as the default", async () => {
    nativeLanguages.computeFullSyntaxHighlighting = async () => ({
      tokens: [
        { length: 1, foreground: 1, fontStyle: 1 },
        { length: 1, foreground: 1, fontStyle: 2 },
        { length: 1, foreground: 1, fontStyle: 4 },
        { length: 1, foreground: 1, fontStyle: 8 },
        { length: 1, foreground: 0, fontStyle: 15 },
      ],
      colorMap: ["#badbad", "#112233"],
    });

    const output = svg(await generateSyntaxHighlightedSvg("abcde", "typescript", true));
    const spans = [...output.matchAll(/<tspan\b([^>]*)>(.*?)<\/tspan>/g)];
    expect(spans.map((span) => span[2])).toEqual(["a", "b", "c", "d", "e"]);
    expect(spans[0]?.[1]).toContain('font-style="italic"');
    expect(spans[1]?.[1]).toContain('font-weight="bold"');
    expect(spans[2]?.[1]).toContain("underline");
    expect(spans[3]?.[1]).toContain("line-through");
    expect(spans[4]?.[1]).toContain('font-style="italic"');
    expect(spans[4]?.[1]).toContain('font-weight="bold"');
    expect(spans[4]?.[1]).toContain("underline");
    expect(spans[4]?.[1]).toContain("line-through");
    expect(spans[4]?.[1]).not.toContain("#badbad");
    expect(spans[4]?.[1]).toContain('fill="#D4D4D4"');
    expect(shiki.create).not.toHaveBeenCalled();
  });

  test("keeps tab-expanded highlight geometry, XML escaping and decoration placement", async () => {
    nativeLanguages.computeFullSyntaxHighlighting = vi.fn(async (source) => colored(source));
    const range = new vscode.Range(new vscode.Position(2, 0), new vscode.Position(2, 0));
    const decoration = await createHighlightedBoxDecoration("\t<&", "typescript", range, [
      { start: 1, end: 3, color: "#00ff00" },
    ]);
    const icon = decoration.renderOptions?.after?.contentIconPath as vscode.Uri;
    const output = svg(icon);

    expect(nativeLanguages.computeFullSyntaxHighlighting).toHaveBeenCalledWith(
      "    <&",
      "typescript",
    );
    expect(output).toContain('viewBox="0 0 36 20"');
    expect(output).toContain('x="24" y="0" width="12" height="20"');
    expect(output).toContain("&#160;&#160;&#160;&#160;&lt;&amp;");
    expect(decoration.range).toBe(range);
    expect(decoration.renderOptions?.after?.textDecoration).toContain("translateY(-40%)");

    const multiline = await createHighlightedBoxDecorationMultiline(["a", "b"], "html", range);
    expect(multiline.renderOptions?.after?.textDecoration).toContain("translateY(-10px)");
    expect(svg(multiline.renderOptions?.after?.contentIconPath as vscode.Uri)).toContain(
      'viewBox="0 0 6 40"',
    );
  });

  test("returns fresh theme colors when the theme changes during native highlighting", async () => {
    const stale = Promise.withResolvers<Highlighting>();
    const compute = vi.fn(async (source: string) => colored(source, "#eeeeee"));
    compute.mockReturnValueOnce(stale.promise);
    nativeLanguages.computeFullSyntaxHighlighting = compute;

    const pending = generateSyntaxHighlightedSvg("let x", "typescript", true);
    expect(compute).toHaveBeenCalledExactlyOnceWith("let x", "typescript");
    reloadTheme();
    stale.resolve(colored("let x", "#111111"));
    const output = svg(await pending);

    expect(output).toContain('fill="#eeeeee"');
    expect(output).not.toContain('fill="#111111"');
    expect(compute).toHaveBeenCalledTimes(2);
    expect(shiki.create).not.toHaveBeenCalled();
  });

  test("theme refresh recomputes native colors without initializing Shiki or discovering theme files", async () => {
    const themeRead = vi.fn(() => []);
    vi.spyOn(vscode.extensions, "all", "get").mockImplementation(themeRead);
    const compute = vi.fn(async (source: string) => colored(source, "#111111"));
    nativeLanguages.computeFullSyntaxHighlighting = compute;
    const first = svg(await generateSyntaxHighlightedSvg("let x", "typescript", true));
    compute.mockImplementation(async (source: string) => colored(source, "#eeeeee"));

    reloadTheme();
    const second = svg(await generateSyntaxHighlightedSvg("let x", "typescript", true));

    expect(first).toContain('fill="#111111"');
    expect(second).toContain('fill="#eeeeee"');
    expect(compute).toHaveBeenCalledTimes(2);
    expect(shiki.create).not.toHaveBeenCalled();
    expect(shiki.load).not.toHaveBeenCalled();
    expect(themeRead).not.toHaveBeenCalled();
  });
});

describe("native highlighting change event", () => {
  test("tolerates a proposal-gated event getter", () => {
    Object.defineProperty(nativeLanguages, "onDidChangeSyntaxHighlighting", {
      configurable: true,
      get() {
        throw new Error("proposal disabled");
      },
    });
    const subscription = onDidChangeSyntaxHighlighting(vi.fn());
    expect(() => subscription.dispose()).not.toThrow();
    expect(shiki.create).not.toHaveBeenCalled();
  });

  test("forwards the host event and returns its disposable", () => {
    const listener = vi.fn();
    const subscription = { dispose: vi.fn() };
    const event = vi.fn(() => subscription);
    Object.defineProperty(nativeLanguages, "onDidChangeSyntaxHighlighting", {
      configurable: true,
      value: event,
    });
    expect(onDidChangeSyntaxHighlighting(listener)).toBe(subscription);
    expect(event).toHaveBeenCalledExactlyOnceWith(listener);
  });
});

describe("Shiki compatibility fallback", () => {
  test("uses the current theme when fallback module initialization spans a theme change", async () => {
    Reflect.set(vscode.window.activeColorTheme, "kind", vscode.ColorThemeKind.Light);

    // Starting fallback rendering reaches its asynchronous module imports before
    // returning this promise, so invalidation happens before initialization settles.
    const pending = generateSyntaxHighlightedSvg("const value = 42;", "typescript", false);
    Reflect.set(vscode.window.activeColorTheme, "kind", vscode.ColorThemeKind.Dark);
    reloadTheme();
    const output = svg(await pending);

    // These are the installed Dark+ and Light+ keyword colors. A disposed or stale
    // highlighter must not leave the render plain or in the previous light theme.
    expect(output).toMatch(/<tspan[^>]*fill="#569cd6"[^>]*>const<\/tspan>/i);
    expect(output).not.toMatch(/fill="#0000ff"/i);
    expect(output).toContain('fill="#1e1e1e"');
  });

  test("uses colored fallback when a positive foreground references a missing color-map entry", async () => {
    nativeLanguages.computeFullSyntaxHighlighting = async (source) => ({
      tokens: [{ length: source.length, foreground: 3, fontStyle: 0 }],
      colorMap: [""],
    });
    const output = svg(await generateSyntaxHighlightedSvg("const value = 42;", "typescript", true));
    const foregrounds = [...output.matchAll(/<tspan[^>]*fill="([^"]+)"/g)].map((span) => span[1]);
    expect(shiki.create).toHaveBeenCalledOnce();
    expect(new Set(foregrounds).size).toBeGreaterThan(1);
  });

  test.each(["absent", "proposal gate throws", "promise rejects"])(
    "keeps syntax colors when native API %s",
    async (failure) => {
      if (failure === "absent") {
        delete nativeLanguages.computeFullSyntaxHighlighting;
      } else if (failure === "proposal gate throws") {
        nativeLanguages.computeFullSyntaxHighlighting = () => {
          throw new Error("proposal disabled");
        };
      } else {
        nativeLanguages.computeFullSyntaxHighlighting = async () => {
          throw new Error("tokenization failed");
        };
      }

      const output = svg(
        await generateSyntaxHighlightedSvg("const value = 42;", "typescript", true),
      );
      const foregrounds = [...output.matchAll(/<tspan[^>]*fill="([^"]+)"/g)].map((span) => span[1]);

      expect(shiki.create).toHaveBeenCalledOnce();
      expect(new Set(foregrounds).size).toBeGreaterThan(1);
      expect(output).toContain("const");
      expect(output).toContain("42");
    },
  );
});
