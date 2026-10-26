import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { desktopDir, electronEnv, electronPath } from "./electron.mjs";
import { waitForResources } from "./wait-for-resources.mjs";

const devServerUrl = process.env.VITE_DEV_SERVER_URL?.trim();
if (!devServerUrl) {
  throw new Error("VITE_DEV_SERVER_URL is required for desktop development.");
}
const devServer = new URL(devServerUrl);
const port = Number.parseInt(devServer.port, 10);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`VITE_DEV_SERVER_URL must include an explicit port: ${devServerUrl}`);
}

const watchedDirectories = [
  { directory: "dist-electron", files: new Set(["main.cjs", "preload.cjs"]) },
  { directory: "../server/dist", files: new Set(["bin.mjs"]) },
];
const forcedShutdownTimeoutMs = 1_500;
const restartDebounceMs = 120;

await waitForResources({
  baseDir: desktopDir,
  files: ["dist-electron/main.cjs", "dist-electron/preload.cjs", "../server/dist/bin.mjs"],
  tcpHost: devServer.hostname,
  tcpPort: port,
});

let shuttingDown = false;
let restartTimer = null;
let currentApp = null;
let restartQueue = Promise.resolve();
const expectedExits = new WeakSet();
const watchers = [];

function startApp() {
  if (shuttingDown || currentApp !== null) return;
  const app = NodeChildProcess.spawn(electronPath, ["."], {
    cwd: desktopDir,
    env: electronEnv(),
    stdio: "inherit",
  });
  currentApp = app;
  app.once("error", () => {
    if (currentApp === app) currentApp = null;
    if (!shuttingDown) scheduleRestart();
  });
  app.once("exit", (code, signal) => {
    if (currentApp === app) currentApp = null;
    // Quitting the app ends dev; a crash restarts it.
    const exitedAbnormally = signal !== null || code !== 0;
    if (!shuttingDown && !expectedExits.has(app)) {
      if (exitedAbnormally) scheduleRestart();
      else void shutdown(0);
    }
  });
}

// The app forwards SIGTERM to its quit handshake, which stops the server it supervises.
async function stopApp() {
  const app = currentApp;
  if (!app) return;
  currentApp = null;
  expectedExits.add(app);
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    app.once("exit", finish);
    app.kill("SIGTERM");
    setTimeout(() => {
      if (settled) return;
      app.kill("SIGKILL");
      finish();
    }, forcedShutdownTimeoutMs).unref();
  });
}

function scheduleRestart() {
  if (shuttingDown) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    restartQueue = restartQueue
      .catch(() => undefined)
      .then(async () => {
        await stopApp();
        if (!shuttingDown) startApp();
      });
  }, restartDebounceMs);
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (restartTimer) clearTimeout(restartTimer);
  for (const watcher of watchers) watcher.close();
  await stopApp();
  process.exit(exitCode);
}

for (const { directory, files } of watchedDirectories) {
  watchers.push(
    NodeFS.watch(NodePath.join(desktopDir, directory), { persistent: true }, (_event, filename) => {
      if (typeof filename === "string" && files.has(filename)) scheduleRestart();
    }),
  );
}
startApp();

process.once("SIGINT", () => void shutdown(130));
process.once("SIGTERM", () => void shutdown(143));
process.once("SIGHUP", () => void shutdown(129));
