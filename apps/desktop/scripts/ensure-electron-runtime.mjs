// Electron's postinstall does not reliably produce a working runtime, and
// `pnpm rebuild electron` inherits both failure modes (verified on CI):
//
// - On Node >= 24.16 / >= 26.1, electron's install.js exits 0 without
//   installing: its extract-zip dependency never settles its promise, the
//   event loop drains, and the process dies silently before writing `dist/`
//   or `path.txt` (https://github.com/electron/electron/issues/51619).
// - pnpm's side-effects cache can replay the package without `dist/` or
//   `path.txt`, skipping the postinstall entirely.
//
// Anything that loads the `electron` package then throws "Electron failed to
// install correctly" — including unit tests that merely import a module which
// imports `electron`. So the runtime is verified (and repaired from GitHub
// releases, bypassing install.js) instead of assumed; same approach as T3
// Code's ensure-electron-runtime script. Deletable once the upstream installer
// is fixed and the workspace floor is past the broken Node range.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const require = NodeModule.createRequire(import.meta.url);
// oxlint-disable-next-line app/no-global-process-runtime -- Standalone repair script has no Effect runtime.
const hostPlatform = NodeOS.platform();
// oxlint-disable-next-line app/no-global-process-runtime -- Standalone repair script has no Effect runtime.
const hostArch = NodeOS.arch();

function getPlatformPath() {
  switch (hostPlatform) {
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "linux":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error(`Electron builds are not available on platform: ${hostPlatform}`);
  }
}

function getRequiredRuntimePaths(electronDir, platformPath) {
  const paths = [NodePath.join(electronDir, "dist", platformPath)];

  if (hostPlatform === "darwin") {
    paths.push(
      NodePath.join(electronDir, "dist", "Electron.app", "Contents", "Info.plist"),
      NodePath.join(
        electronDir,
        "dist",
        "Electron.app",
        "Contents",
        "Frameworks",
        "Electron Framework.framework",
        "Electron Framework",
      ),
    );
  }

  return paths;
}

function missingRuntimePaths(electronDir, platformPath) {
  return getRequiredRuntimePaths(electronDir, platformPath).filter(
    (runtimePath) => !NodeFS.existsSync(runtimePath),
  );
}

// A present-but-truncated binary (interrupted extract) is as broken as a
// missing one; on macOS `file` distinguishes real Mach-O output from junk.
function invalidRuntimePaths(electronDir, platformPath) {
  if (hostPlatform !== "darwin") {
    return [];
  }

  return [
    NodePath.join(electronDir, "dist", platformPath),
    NodePath.join(
      electronDir,
      "dist",
      "Electron.app",
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Electron Framework",
    ),
  ].filter((runtimePath) => {
    if (!NodeFS.existsSync(runtimePath)) {
      return false;
    }
    const result = NodeChildProcess.spawnSync("file", ["-b", runtimePath], { encoding: "utf8" });
    return result.status !== 0 || !result.stdout.includes("Mach-O");
  });
}

function runChecked(command, args) {
  const result = NodeChildProcess.spawnSync(command, args, { encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`,
    );
  }
}

function installElectronRuntime(electronDir, version) {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "electron-runtime-"));
  const zipPath = NodePath.join(tempDir, `electron-v${version}-${hostPlatform}-${hostArch}.zip`);

  try {
    runChecked("curl", [
      "-fsSL",
      `https://github.com/electron/electron/releases/download/v${version}/electron-v${version}-${hostPlatform}-${hostArch}.zip`,
      "-o",
      zipPath,
    ]);
    if (hostPlatform === "darwin") {
      // ditto preserves symlinks and code-signing metadata inside Electron.app.
      runChecked("ditto", ["-x", "-k", zipPath, NodePath.join(electronDir, "dist")]);
    } else {
      runChecked("python3", [
        "-c",
        "import os, sys, zipfile; os.makedirs(sys.argv[2], exist_ok=True); zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
        zipPath,
        NodePath.join(electronDir, "dist"),
      ]);
    }
  } finally {
    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function ensureElectronRuntime() {
  const electronPackageJsonPath = require.resolve("electron/package.json");
  const electronPackageJson = JSON.parse(NodeFS.readFileSync(electronPackageJsonPath, "utf8"));
  const electronDir = NodePath.dirname(electronPackageJsonPath);
  const platformPath = getPlatformPath();
  const electronPath = NodePath.join(electronDir, "dist", platformPath);

  if (
    missingRuntimePaths(electronDir, platformPath).length > 0 ||
    invalidRuntimePaths(electronDir, platformPath).length > 0
  ) {
    NodeFS.rmSync(NodePath.join(electronDir, "dist"), { recursive: true, force: true });
    NodeFS.rmSync(NodePath.join(electronDir, "path.txt"), { force: true });
    installElectronRuntime(electronDir, electronPackageJson.version);
  }

  const missing = missingRuntimePaths(electronDir, platformPath);
  const invalid = invalidRuntimePaths(electronDir, platformPath);
  if (missing.length > 0 || invalid.length > 0) {
    throw new Error(
      `Electron runtime is incomplete after install.\nMissing:\n${missing
        .map((runtimePath) => `- ${runtimePath}`)
        .join("\n")}\nInvalid:\n${invalid.map((runtimePath) => `- ${runtimePath}`).join("\n")}`,
    );
  }

  if (hostPlatform !== "win32") {
    NodeFS.chmodSync(electronPath, 0o755);
  }

  // electron/index.js resolves the binary through path.txt; postinstall
  // failures leave it absent or stale.
  const pathFile = NodePath.join(electronDir, "path.txt");
  const currentPath = NodeFS.existsSync(pathFile)
    ? NodeFS.readFileSync(pathFile, "utf8")
    : undefined;
  if (currentPath !== platformPath) {
    NodeFS.writeFileSync(pathFile, platformPath);
  }

  return electronPath;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${ensureElectronRuntime()}\n`);
}
