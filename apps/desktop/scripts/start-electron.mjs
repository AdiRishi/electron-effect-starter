// Minimal Electron launcher for `pnpm --filter @app/desktop start`. Verifies
// (and repairs) the Electron runtime, then spawns it against the built main
// entry. Clears ELECTRON_RUN_AS_NODE so the parent's Node-mode flag (set when
// the shell spawns the server child) can't leak in and make Electron boot as
// plain Node.

import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { ensureElectronRuntime } from "./ensure-electron-runtime.mjs";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const desktopDir = NodePath.resolve(__dirname, "..");

const electronPath = ensureElectronRuntime();

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
