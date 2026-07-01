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

const MODES = ["dev", "dev:server", "dev:web", "dev:desktop"] as const;
type Mode = (typeof MODES)[number];

const REPO_ROOT = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));

const BASE_SERVER_PORT = 13773;
const BASE_WEB_PORT = 5733;
const MAX_PORT = 65_535;

const mode = (process.argv[2] ?? "dev") as Mode;
if (!MODES.includes(mode)) {
  process.stderr.write(`Unknown mode "${mode}". Use one of: ${MODES.join(", ")}\n`);
  process.exit(1);
}

/** Stable per-checkout offset so multiple clones don't fight over ports. */
function repoPortOffset(): number {
  const hash = NodeCrypto.createHash("sha256").update(REPO_ROOT).digest();
  return hash.readUInt16BE(0) % 2000;
}

function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = NodeNet.createServer();
    server.once("error", () => {
      server.removeAllListeners();
      server.close();
      resolve(false);
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function pickPort(start: number): Promise<number> {
  for (let port = start; port <= MAX_PORT; port += 1) {
    if ((await canListen(port, "127.0.0.1")) && (await canListen(port, "0.0.0.0"))) {
      return port;
    }
  }
  throw new Error(`No free port available from ${start}.`);
}

function run(filter: string, script: string, env: NodeJS.ProcessEnv): NodeChildProcess.ChildProcess {
  const child = NodeChildProcess.spawn("pnpm", ["--filter", filter, script], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: "inherit",
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
  const offset = repoPortOffset();
  const serverPort =
    process.env.APP_SERVER_PORT !== undefined
      ? Number(process.env.APP_SERVER_PORT)
      : await pickPort(BASE_SERVER_PORT + offset);
  const webPort =
    process.env.APP_WEB_PORT !== undefined
      ? Number(process.env.APP_WEB_PORT)
      : await pickPort(BASE_WEB_PORT + offset);
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

  process.stdout.write(
    `[dev-runner] mode=${mode} server=${serverPort} web=${webPort}\n` +
      `[dev-runner] open ${devWebUrl} in a browser, or run \`pnpm dev:desktop\` for the shell.\n`,
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

  const shutdown = () => {
    for (const child of children) child.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`[dev-runner] fatal: ${String(error)}\n`);
  process.exit(1);
});
