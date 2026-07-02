// Minimal Electron launcher for `pnpm --filter @app/desktop start`. Resolves the
// Electron binary from the installed `electron` package and spawns it against
// the built main entry. Clears ELECTRON_RUN_AS_NODE so the parent's Node-mode
// flag (set when the shell spawns the server child) can't leak in and make
// Electron boot as plain Node.

import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const desktopDir = NodePath.resolve(__dirname, "..");

const require = NodeModule.createRequire(import.meta.url);

// electron's postinstall can be skipped on CI or replayed incompletely by
// pnpm's side-effects cache, leaving the package without its binary. Its
// install.js verifies and repairs, so a failed resolve gets one rebuild;
// Node evicts modules that throw during load, so the retry re-evaluates.
function resolveElectronPath() {
  try {
    return require("electron");
  } catch {
    NodeChildProcess.execSync("pnpm rebuild electron", { cwd: desktopDir, stdio: "inherit" });
    return require("electron");
  }
}

const electronPath = resolveElectronPath();

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const child = NodeChildProcess.spawn(
  electronPath,
  ["dist-electron/main.cjs", ...process.argv.slice(2)],
  {
    stdio: "inherit",
    cwd: desktopDir,
    env: childEnv,
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
