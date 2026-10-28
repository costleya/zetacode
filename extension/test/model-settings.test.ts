import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { config } from "~/core/config.ts";

function setConfiguration(values: Record<string, unknown>): void {
  (
    globalThis as typeof globalThis & {
      __vscodeMockConfiguration?: Record<string, unknown>;
    }
  ).__vscodeMockConfiguration = values;
}

afterEach(() => setConfiguration({}));

describe("model settings", () => {
  test("exposes no bundled backend selection or continuation toggle settings", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      contributes: { configuration: { properties: Record<string, unknown> }[] };
    };
    const properties = Object.assign(
      {},
      ...manifest.contributes.configuration.map((group) => group.properties),
    );
    for (const setting of [
      "serverUrl",
      "manageLocalServer",
      "modelName",
      "continuationModelName",
      "continuationFallbackEnabled",
    ]) {
      expect(Object.keys(properties)).not.toContain(`zetacode.${setting}`);
      expect(config).not.toHaveProperty(setting);
    }
  });

  test("defaults to the 350-token editable budget", () => {
    setConfiguration({});

    expect(config.editableTokens).toBe(350);
  });

  test("preserves editable budget overrides despite legacy model settings", () => {
    setConfiguration({ modelName: "local-model-alias", editableTokens: 900 });

    expect(config.editableTokens).toBe(900);
  });
});
