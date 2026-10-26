import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
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

function isLinuxSetuidSandboxConfigured() {
  if (NodeOS.platform() !== "linux") return true;

  const sandboxPath = NodePath.join(NodePath.dirname(electronPath), "chrome-sandbox");

  try {
    const sandboxStat = NodeFS.statSync(sandboxPath);

    return sandboxStat.uid === 0 && (sandboxStat.mode & 0o4777) === 0o4755;
  } catch {
    return false;
  }
}

/**
 * An npm-installed Electron's chrome-sandbox is not root-owned and setuid, and Electron aborts on
 * Linux hosts without unprivileged user namespaces unless it runs without the sandbox.
 */
export function electronLaunchArgs(args) {
  if (isLinuxSetuidSandboxConfigured()) return args;

  console.warn(
    "[desktop-launcher] Electron chrome-sandbox is not root-owned with mode 4755; launching local Electron with --no-sandbox.",
  );

  return ["--no-sandbox", ...args];
}
