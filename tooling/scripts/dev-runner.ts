import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@app/shared/Net";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const BASE_SERVER_PORT = 13773;
const BASE_WEB_PORT = 5733;
const MAX_OFFSET = 1000;

const DevMode = Schema.Literals(["dev", "dev:server", "dev:web", "dev:desktop"]);
type DevMode = typeof DevMode.Type;

const PACKAGES_BY_MODE: Record<DevMode, ReadonlyArray<string>> = {
  dev: ["@app/server", "@app/web"],
  "dev:server": ["@app/server"],
  "dev:web": ["@app/web"],
  // The desktop shell spawns the built server itself, so dev:desktop runs Vite and the shell.
  "dev:desktop": ["@app/web", "@app/desktop"],
};

export class DevRunnerPortsExhaustedError extends Schema.TaggedError<DevRunnerPortsExhaustedError>()(
  "DevRunnerPortsExhaustedError",
  { startOffset: Schema.Number },
) {
  override get message(): string {
    return `No free server and web port pair from offset ${this.startOffset}.`;
  }
}

/**
 * Ports derive from the checkout path, so several clones or worktrees run side by side without
 * colliding and each keeps its ports across restarts. APP_PORT_OFFSET overrides the derivation.
 */
const resolvePorts = Effect.fn("dev-runner.resolvePorts")(function* (repoRoot: string) {
  const net = yield* NetService.NetService;
  const configuredOffset = yield* Config.Int("APP_PORT_OFFSET").pipe(Config.option);
  const startOffset = Option.getOrElse(
    configuredOffset,
    () => (Hash.string(repoRoot) >>> 0) % MAX_OFFSET,
  );
  for (let offset = startOffset; offset < startOffset + MAX_OFFSET; offset += 1) {
    const serverPort = BASE_SERVER_PORT + offset;
    const webPort = BASE_WEB_PORT + offset;
    if (
      (yield* net.isPortAvailableOnLoopback(serverPort)) &&
      (yield* net.isPortAvailableOnLoopback(webPort))
    ) {
      return { serverPort, webPort };
    }
  }
  return yield* new DevRunnerPortsExhaustedError({ startOffset });
});

export class DevRunnerTurboExitError extends Schema.TaggedError<DevRunnerTurboExitError>()(
  "DevRunnerTurboExitError",
  { exitCode: Schema.Number },
) {
  override get message(): string {
    return `turbo exited with code ${this.exitCode}.`;
  }
}

const run = Effect.fn("dev-runner.run")(function* (mode: DevMode) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const { serverPort, webPort } = yield* resolvePorts(repoRoot);
  const webUrl = `http://127.0.0.1:${webPort}`;

  yield* Effect.logInfo(`[dev-runner] ${mode}`, {
    server: `http://127.0.0.1:${serverPort}`,
    web: webUrl,
  });

  const filters = PACKAGES_BY_MODE[mode].map((name) => `--filter=${name}`);
  const handle = yield* spawner.spawn(
    ChildProcess.make("pnpm", ["exec", "turbo", "run", "dev", ...filters, "--ui=stream"], {
      cwd: repoRoot,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      extendEnv: true,
      env: {
        APP_PORT: String(serverPort),
        APP_WEB_PORT: String(webPort),
        // The server redirects page loads to Vite and prints sign-in links on Vite's origin.
        VITE_DEV_SERVER_URL: webUrl,
        // Dev state lives in the checkout, so a dev server never opens the installed app's data.
        APP_HOME: path.join(repoRoot, ".data"),
        ...(mode === "dev:desktop" ? { APP_DESKTOP_DEV: "1" } : {}),
      },
    }),
  );
  const exitCode = yield* handle.exitCode;
  if (exitCode !== 0) return yield* new DevRunnerTurboExitError({ exitCode });
}, Effect.scoped);

const cli = Command.make("dev-runner", {
  mode: Argument.Literals("mode", DevMode.literals),
}).pipe(Command.withHandler(({ mode }) => run(mode)));

Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer)),
  NodeRuntime.runMain,
);
