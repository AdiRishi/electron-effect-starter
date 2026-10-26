import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const desktopDir = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);

/**
 * Resolving the electron package from Node returns the path to its binary. Launch it with the
 * package directory, not a script path, so Electron reads package.json and names the app (and its
 * userData directory) after productName.
 */
export const electronPath = NodeModule.createRequire(import.meta.url)("electron");

/** Electron must not inherit ELECTRON_RUN_AS_NODE, or it starts as plain Node. */
export function electronEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;

  return env;
}
