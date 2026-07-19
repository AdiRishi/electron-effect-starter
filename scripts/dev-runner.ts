#!/usr/bin/env node
// Dev orchestrator. Derives collision-avoiding ports per checkout, mints one
// shared bootstrap token, and launches the server + web (+ optionally the
// desktop shell) with a consistent environment.
//
// The T3 Code original is an Effect CLI program (see the reference repo's
// scripts/dev-runner.ts). This starter keeps it as a dependency-free Node
// script so `pnpm dev` works before anything is installed into the workspace.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { loadRepoEnv } from "./lib/public-config.ts";

const MODES = ["dev", "dev:server", "dev:web", "dev:desktop"] as const;
type Mode = (typeof MODES)[number];

const REPO_ROOT = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));

const BASE_SERVER_PORT = 13773;
const BASE_WEB_PORT = 5733;
const MAX_PORT = 65_535;
const DEV_PORT_PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::1", "::"] as const;
const FORCE_KILL_AFTER_MS = 1500;

const isMode = (value: string): value is Mode => (MODES as readonly string[]).includes(value);

const modeArgument = process.argv[2] ?? "dev";
if (!isMode(modeArgument)) {
  process.stderr.write(`Unknown mode "${modeArgument}". Use one of: ${MODES.join(", ")}\n`);
  process.exit(1);
}
const mode = modeArgument;

/** Stable per-checkout offset so multiple clones don't fight over ports. */
function repoPortOffset(): number {
  const hash = NodeCrypto.createHash("sha256").update(REPO_ROOT).digest();
  return hash.readUInt16BE(0) % 2000;
}

function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = NodeNet.createServer();
    server.once("error", (cause: NodeJS.ErrnoException) => {
      server.removeAllListeners();
      server.close();
      // Hosts without IPv6 reject "::1"/"::" binds with EADDRNOTAVAIL; treat
      // that as available so the probe doesn't mark every port as busy.
      resolve(cause.code === "EADDRNOTAVAIL");
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen({ host, port });
  });
}

async function pickPort(start: number): Promise<number> {
  for (let port = start; port <= MAX_PORT; port += 1) {
    let available = true;
    for (const host of DEV_PORT_PROBE_HOSTS) {
      if (!(await canListen(port, host))) {
        available = false;
        break;
      }
    }
    if (available) return port;
  }
  throw new Error(`No free port available from ${start}.`);
}

function run(
  filter: string,
  script: string,
  env: NodeJS.ProcessEnv,
): NodeChildProcess.ChildProcess {
  const child = NodeChildProcess.spawn("pnpm", ["--filter", filter, script], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: "inherit",
    // oxlint-disable-next-line app/no-global-process-runtime -- Standalone Node script has no Effect runtime (see file header).
    shell: process.platform === "win32",
  });
  child.on("exit", (code) => {
    if (code !== null && code !== 0) {
      process.stderr.write(`[dev-runner] ${filter} ${script} exited with ${code}\n`);
    }
  });
  return child;
}

async function main(): Promise<void> {
  // Layer repo-root .env / .env.local under the real environment so the
  // overrides documented in .env.example (APP_SERVER_PORT, APP_WEB_PORT) take
  // effect. A real shell env var still wins — we only fill keys not already set.
  for (const [key, value] of Object.entries(loadRepoEnv({ baseEnv: {} }))) {
    if (value !== undefined && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  // A malformed override (e.g. APP_SERVER_PORT=abc in .env.local) falls back to
  // auto-selection with a warning, instead of silently exporting "NaN" to the
  // children (whose stricter parsers would then diverge to their own defaults).
  const envPort = (key: string): number | undefined => {
    const raw = process.env[key];
    if (raw === undefined) return undefined;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_PORT) return parsed;
    process.stderr.write(`[dev-runner] ignoring invalid ${key}="${raw}"\n`);
    return undefined;
  };

  const offset = repoPortOffset();
  const serverPort = envPort("APP_SERVER_PORT") ?? (await pickPort(BASE_SERVER_PORT + offset));
  const webPort = envPort("APP_WEB_PORT") ?? (await pickPort(BASE_WEB_PORT + offset));
  const bootstrapToken = NodeCrypto.randomBytes(24).toString("hex");
  const wsUrl = `ws://127.0.0.1:${serverPort}`;
  const devWebUrl = `http://localhost:${webPort}`;

  const serverEnv: NodeJS.ProcessEnv = {
    APP_SERVER_PORT: String(serverPort),
    APP_BOOTSTRAP_TOKEN: bootstrapToken,
    APP_DEV_WEB_URL: devWebUrl,
  };
  const webEnv: NodeJS.ProcessEnv = {
    PORT: String(webPort),
    HOST: "localhost",
    VITE_WS_URL: wsUrl,
    VITE_BOOTSTRAP_TOKEN: bootstrapToken,
  };
  const desktopEnv: NodeJS.ProcessEnv = {
    APP_SERVER_PORT: String(serverPort),
    APP_DEV_WEB_URL: devWebUrl,
    // The shell spawns the server via Electron-as-node, which can't run `.ts`,
    // so point it at the built bundle (dev:desktop builds it first, below).
    APP_SERVER_ENTRY: NodePath.join(REPO_ROOT, "apps/server/dist/bin.mjs"),
  };

  const targetMessage =
    mode === "dev:desktop"
      ? `[dev-runner] Electron will load ${devWebUrl} for the shell.\n`
      : `[dev-runner] open ${devWebUrl} in a browser, or run \`pnpm dev:desktop\` for the shell.\n`;

  process.stdout.write(
    `[dev-runner] mode=${mode} server=${serverPort} web=${webPort}\n` + targetMessage,
  );

  const children: NodeChildProcess.ChildProcess[] = [];
  // `dev`/`dev:server` run the server standalone; in `dev:desktop` the Electron
  // shell spawns its own server, so we don't start a second one here.
  if (mode === "dev" || mode === "dev:server") {
    children.push(run("@app/server", "dev", serverEnv));
  }
  if (mode === "dev" || mode === "dev:web" || mode === "dev:desktop") {
    children.push(run("@app/web", "dev", webEnv));
  }
  if (mode === "dev:desktop") {
    // The shell loads the vite dev URL for HMR but spawns the built server
    // bundle, so both it and the server must be built before launch.
    process.stdout.write("[dev-runner] building server + desktop for the shell...\n");
    NodeChildProcess.execSync("pnpm --filter @app/server --filter @app/desktop build", {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    children.push(run("@app/desktop", "start", desktopEnv));
  }

  // SIGTERM everything, give children a short grace period to exit cleanly,
  // then SIGKILL any survivor so nothing is orphaned when the runner exits.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const alive = children.filter((child) => child.exitCode === null && child.signalCode === null);
    if (alive.length === 0) process.exit(0);
    let remaining = alive.length;
    const forceKillTimer = setTimeout(() => {
      for (const child of alive) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    }, FORCE_KILL_AFTER_MS);
    for (const child of alive) {
      child.once("exit", () => {
        remaining -= 1;
        if (remaining === 0) {
          clearTimeout(forceKillTimer);
          process.exit(0);
        }
      });
      child.kill("SIGTERM");
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`[dev-runner] fatal: ${String(error)}\n`);
  process.exit(1);
});
