// Run standalone production integration scripts under Node's native TS support.
import { registerHooks } from "node:module";
const root = new URL("../", import.meta.url);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("~/"))
      return nextResolve(new URL(`src/${specifier.slice(2)}`, root).href, context);
    if (specifier === "vscode")
      return { url: "data:text/javascript,export const window = {};", shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
