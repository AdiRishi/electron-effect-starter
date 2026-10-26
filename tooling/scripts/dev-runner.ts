import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@app/shared/HostProcess";
import * as NetService from "@app/shared/Net";
import { resolveSpawnCommand } from "@app/shared/shell";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";
import { ChildProcess } from "effect/process";

const BASE_SERVER_PORT = 13773;
const BASE_WEB_PORT = 5733;
const MAX_HASH_OFFSET = 1000;
const MAX_PORT = 65535;
const DEV_LOOPBACK_HOST = "127.0.0.1";

// Browsers block these ports before networking even when curl accepts them.
// https://fetch.spec.whatwg.org/#port-blocking
const FETCH_BAD_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

// Dev binds loopback; other interfaces cannot establish port availability.
const DEV_PORT_PROBE_HOSTS = ["127.0.0.1", "::1"] as const;

const DevMode = Schema.Literals(["dev", "dev:server", "dev:web", "dev:desktop"]);

type DevMode = typeof DevMode.Type;

const PACKAGES_BY_MODE: Record<DevMode, ReadonlyArray<string>> = {
  dev: ["@app/server", "@app/web"],
  "dev:server": ["@app/server"],
  "dev:web": ["@app/web"],
  // The desktop shell spawns the built server itself, so dev:desktop runs Vite and the shell.
  "dev:desktop": ["@app/web", "@app/desktop"],
};

type PortAvailabilityCheck<R = never> = (port: number) => Effect.Effect<boolean, never, R>;

export function isBrowserAllowedPort(port: number): boolean {
  return !FETCH_BAD_PORTS.has(port);
}

export class DevRunnerConfigurationError extends Schema.TaggedError<DevRunnerConfigurationError>()(
  "DevRunnerConfigurationError",
  {
    configKeys: Schema.Array(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read dev-runner configuration: ${this.configKeys.join(", ")}.`;
  }
}

export class DevRunnerInvalidPortOffsetError extends Schema.TaggedError<DevRunnerInvalidPortOffsetError>()(
  "DevRunnerInvalidPortOffsetError",
  {
    configKey: Schema.Literal("APP_PORT_OFFSET"),
    portOffset: Schema.Number,
    minimum: Schema.Number,
  },
) {
  override get message(): string {
    return `${this.configKey} must be at least ${this.minimum}; received ${this.portOffset}.`;
  }
}

export class DevRunnerPortExhaustedError extends Schema.TaggedError<DevRunnerPortExhaustedError>()(
  "DevRunnerPortExhaustedError",
  {
    startOffset: Schema.Number,
    requireServerPort: Schema.Boolean,
    requireWebPort: Schema.Boolean,
    baseServerPort: Schema.Number,
    baseWebPort: Schema.Number,
    maximumPort: Schema.Number,
  },
) {
  override get message(): string {
    return `No required dev ports were available from offset ${this.startOffset} through maximum port ${this.maximumPort}.`;
  }
}

export class DevRunnerProcessError extends Schema.TaggedError<DevRunnerProcessError>()(
  "DevRunnerProcessError",
  {
    operation: Schema.Literals(["spawn", "wait-for-exit"]),
    mode: DevMode,
    executable: Schema.Literal("turbo"),
    argumentCount: Schema.Number,
    shell: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Dev-runner process operation "${this.operation}" failed for mode "${this.mode}".`;
  }
}

export class DevRunnerProcessExitError extends Schema.TaggedError<DevRunnerProcessExitError>()(
  "DevRunnerProcessExitError",
  {
    mode: DevMode,
    executable: Schema.Literal("turbo"),
    argumentCount: Schema.Number,
    shell: Schema.Boolean,
    exitCode: Schema.Number,
  },
) {
  override get message(): string {
    return `Dev-runner process exited with code ${this.exitCode} in mode "${this.mode}".`;
  }
}

const optionalPortConfig = (name: string): Config.Config<number | undefined> =>
  Config.Port(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );

const optionalIntegerConfig = (name: string): Config.Config<number | undefined> =>
  Config.Int(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );

/**
 * Ports derive from the checkout path, so several clones or worktrees run side by side without
 * colliding and each keeps its ports across restarts. APP_PORT_OFFSET overrides the derivation.
 */
export function resolveOffset(config: {
  readonly portOffset: number | undefined;
  readonly checkoutPath: string;
}): Effect.Effect<
  { readonly offset: number; readonly source: string },
  DevRunnerInvalidPortOffsetError
> {
  if (config.portOffset !== undefined) {
    if (config.portOffset < 0) {
      return Effect.fail(
        new DevRunnerInvalidPortOffsetError({
          configKey: "APP_PORT_OFFSET",
          portOffset: config.portOffset,
          minimum: 0,
        }),
      );
    }

    return Effect.succeed({
      offset: config.portOffset,
      source: `APP_PORT_OFFSET=${config.portOffset}`,
    });
  }

  const offset = (Hash.string(config.checkoutPath) >>> 0) % MAX_HASH_OFFSET;

  return Effect.succeed({ offset, source: `checkout ${config.checkoutPath}` });
}

interface CreateDevRunnerEnvInput {
  readonly mode: DevMode;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly serverOffset: number;
  readonly webOffset: number;
  readonly appHome: string;
  readonly port: number | undefined;
  readonly devUrl: URL | undefined;
}

export function createDevRunnerEnv({
  mode,
  baseEnv,
  serverOffset,
  webOffset,
  appHome,
  port,
  devUrl,
}: CreateDevRunnerEnvInput): NodeJS.ProcessEnv {
  const serverPort = port ?? BASE_SERVER_PORT + serverOffset;
  const webPort = BASE_WEB_PORT + webOffset;

  const output: NodeJS.ProcessEnv = {
    ...baseEnv,
    APP_PORT: String(serverPort),
    APP_WEB_PORT: String(webPort),
    // The server redirects page loads to Vite and prints sign-in links on Vite's origin.
    VITE_DEV_SERVER_URL: devUrl?.toString() ?? `http://${DEV_LOOPBACK_HOST}:${webPort}`,
    // Dev state lives in the checkout, so a dev server never opens the installed app's data.
    APP_HOME: appHome,
  };

  // Dev is single-origin: Vite proxies the server, so the client resolves it from
  // window.location.origin. A baked-in server URL would bypass the proxy.
  delete output.VITE_HTTP_URL;
  delete output.VITE_WS_URL;

  // tsdown launches Electron after each desktop build when this is set.
  if (mode === "dev:desktop") {
    output.APP_DESKTOP_DEV = "1";
  } else {
    delete output.APP_DESKTOP_DEV;
  }

  return output;
}

function portPairForOffset(offset: number) {
  return {
    serverPort: BASE_SERVER_PORT + offset,
    webPort: BASE_WEB_PORT + offset,
  };
}

export const checkPortAvailabilityOnHosts = Effect.fn("dev-runner.checkPortAvailabilityOnHosts")(
  function* <R>(
    port: number,
    hosts: ReadonlyArray<string>,
    canListenOnHost: (port: number, host: string) => Effect.Effect<boolean, never, R>,
  ): Effect.fn.Return<boolean, never, R> {
    for (const host of hosts) {
      if (!(yield* canListenOnHost(port, host))) {
        return false;
      }
    }

    return true;
  },
);

const defaultCheckPortAvailability: PortAvailabilityCheck<NetService.NetService> = Effect.fn(
  "dev-runner.defaultCheckPortAvailability",
)(function* (port: number) {
  const net = yield* NetService.NetService;

  return yield* checkPortAvailabilityOnHosts(port, DEV_PORT_PROBE_HOSTS, (candidatePort, host) =>
    net.canListenOnHost(candidatePort, host),
  );
});

interface FindFirstAvailableOffsetInput<R> {
  readonly startOffset: number;
  readonly requireServerPort: boolean;
  readonly requireWebPort: boolean;
  readonly checkPortAvailability: PortAvailabilityCheck<R>;
}

export const findFirstAvailableOffset = Effect.fn("dev-runner.findFirstAvailableOffset")(function* <
  R,
>({
  startOffset,
  requireServerPort,
  requireWebPort,
  checkPortAvailability,
}: FindFirstAvailableOffsetInput<R>): Effect.fn.Return<number, DevRunnerPortExhaustedError, R> {
  for (let candidate = startOffset; ; candidate += 1) {
    const { serverPort, webPort } = portPairForOffset(candidate);
    const serverPortOutOfRange = serverPort > MAX_PORT;
    const webPortOutOfRange = webPort > MAX_PORT;

    if (
      (requireServerPort && serverPortOutOfRange) ||
      (requireWebPort && webPortOutOfRange) ||
      (!requireServerPort && !requireWebPort && (serverPortOutOfRange || webPortOutOfRange))
    ) {
      break;
    }

    if (requireWebPort && !isBrowserAllowedPort(webPort)) {
      continue;
    }

    const checks: Array<Effect.Effect<boolean, never, R>> = [];

    if (requireServerPort) {
      checks.push(checkPortAvailability(serverPort));
    }

    if (requireWebPort) {
      checks.push(checkPortAvailability(webPort));
    }

    if (checks.length === 0) {
      return candidate;
    }

    const availability = yield* Effect.all(checks);

    if (availability.every(Boolean)) {
      return candidate;
    }
  }

  return yield* new DevRunnerPortExhaustedError({
    startOffset,
    requireServerPort,
    requireWebPort,
    baseServerPort: BASE_SERVER_PORT,
    baseWebPort: BASE_WEB_PORT,
    maximumPort: MAX_PORT,
  });
});

interface ResolveModePortOffsetsInput<R> {
  readonly mode: DevMode;
  readonly startOffset: number;
  readonly hasExplicitServerPort: boolean;
  readonly hasExplicitDevUrl: boolean;
  readonly checkPortAvailability: PortAvailabilityCheck<R>;
}

export const resolveModePortOffsets = Effect.fn("dev-runner.resolveModePortOffsets")(function* <R>({
  mode,
  startOffset,
  hasExplicitServerPort,
  hasExplicitDevUrl,
  checkPortAvailability,
}: ResolveModePortOffsetsInput<R>): Effect.fn.Return<
  { readonly serverOffset: number; readonly webOffset: number },
  DevRunnerPortExhaustedError,
  R
> {
  // dev:web proxies to the dev:server started with the same offset, so only the web port moves.
  if (mode === "dev:web") {
    if (hasExplicitDevUrl) {
      return { serverOffset: startOffset, webOffset: startOffset };
    }

    const webOffset = yield* findFirstAvailableOffset({
      startOffset,
      requireServerPort: false,
      requireWebPort: true,
      checkPortAvailability,
    });

    return { serverOffset: startOffset, webOffset };
  }

  if (mode === "dev:server") {
    if (hasExplicitServerPort) {
      return { serverOffset: startOffset, webOffset: startOffset };
    }

    const serverOffset = yield* findFirstAvailableOffset({
      startOffset,
      requireServerPort: true,
      requireWebPort: false,
      checkPortAvailability,
    });

    return { serverOffset, webOffset: serverOffset };
  }

  const sharedOffset = yield* findFirstAvailableOffset({
    startOffset,
    requireServerPort: !hasExplicitServerPort,
    requireWebPort: !hasExplicitDevUrl,
    checkPortAvailability,
  });

  return { serverOffset: sharedOffset, webOffset: sharedOffset };
});

interface DevRunnerCliInput {
  readonly mode: DevMode;
  readonly port: number | undefined;
  readonly devUrl: URL | undefined;
  readonly dryRun: boolean;
  readonly runArgs: ReadonlyArray<string>;
}

export const runDevRunnerWithInput = Effect.fn("dev-runner.runDevRunnerWithInput")(function* (
  input: DevRunnerCliInput,
) {
  const path = yield* Path.Path;
  const repoRoot = path.resolve(import.meta.dirname, "../..");

  const portOffset = yield* optionalIntegerConfig("APP_PORT_OFFSET").pipe(
    Effect.mapError(
      (cause) => new DevRunnerConfigurationError({ configKeys: ["APP_PORT_OFFSET"], cause }),
    ),
  );

  const { offset, source } = yield* resolveOffset({ portOffset, checkoutPath: repoRoot });

  const { serverOffset, webOffset } = yield* resolveModePortOffsets({
    mode: input.mode,
    startOffset: offset,
    hasExplicitServerPort: input.port !== undefined,
    hasExplicitDevUrl: input.devUrl !== undefined,
    checkPortAvailability: defaultCheckPortAvailability,
  });

  const env = createDevRunnerEnv({
    mode: input.mode,
    baseEnv: yield* HostProcess.Environment,
    serverOffset,
    webOffset,
    appHome: path.join(repoRoot, ".data"),
    port: input.port,
    devUrl: input.devUrl,
  });

  const selectionSuffix =
    serverOffset !== offset || webOffset !== offset
      ? ` selectedOffset(server=${serverOffset},web=${webOffset})`
      : "";

  yield* Effect.logInfo(
    `[dev-runner] mode=${input.mode} source=${source}${selectionSuffix} serverPort=${String(env.APP_PORT)} webPort=${String(env.APP_WEB_PORT)} web=${String(env.VITE_DEV_SERVER_URL)}`,
  );

  if (input.dryRun) {
    return;
  }

  const filters = PACKAGES_BY_MODE[input.mode].map((name) => `--filter=${name}`);
  const args = ["run", "dev", ...filters, "--ui=stream", ...input.runArgs];
  // turbo's own bin, not `pnpm exec turbo`: a corepack pnpm shim exits on SIGTERM without
  // passing it on, and pnpm starts turbo in a new process group, so stopping the runner
  // would orphan turbo and every dev server under it.
  const turbo = path.join(repoRoot, "node_modules", ".bin", "turbo");
  const spawnCommand = yield* resolveSpawnCommand(turbo, args, { env });

  const processContext = {
    mode: input.mode,
    executable: "turbo" as const,
    argumentCount: args.length,
    shell: spawnCommand.shell,
  } as const;

  const child = yield* ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    cwd: repoRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env,
    extendEnv: false,
    shell: spawnCommand.shell,
    // Keep turbo in the same process group so terminal signals (Ctrl+C)
    // reach it directly. Effect defaults to detached: true on non-Windows,
    // which would put the runner in a new group and require manual forwarding.
    detached: false,
    forceKillAfter: "1500 millis",
  }).pipe(
    Effect.mapError(
      (cause) =>
        new DevRunnerProcessError({
          ...processContext,
          operation: "spawn",
          cause,
        }),
    ),
  );

  const exitCode = yield* child.exitCode.pipe(
    Effect.mapError(
      (cause) =>
        new DevRunnerProcessError({
          ...processContext,
          operation: "wait-for-exit",
          cause,
        }),
    ),
  );

  if (exitCode !== 0) {
    return yield* new DevRunnerProcessExitError({
      ...processContext,
      exitCode,
    });
  }
}, Effect.scoped);

const devRunnerCli = Command.make("dev-runner", {
  mode: Argument.Literals("mode", DevMode.literals).pipe(
    Argument.withDescription("Development mode to run."),
  ),
  port: Flag.Int("port").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    Flag.withDescription("Server port override (forwards to APP_PORT)."),
    Flag.withFallbackConfig(optionalPortConfig("APP_PORT")),
  ),
  devUrl: Flag.String("dev-url").pipe(
    Flag.withSchema(Schema.URLFromString),
    Flag.withDescription(
      "Explicit web dev URL override (forwards to VITE_DEV_SERVER_URL). Ambient VITE_DEV_SERVER_URL values are ignored so a parent dev app cannot redirect the child runner.",
    ),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Resolve mode/ports/env and print, but do not spawn turbo."),
    Flag.withDefault(false),
  ),
  runArgs: Argument.String("run-arg").pipe(
    Argument.withDescription("Additional turbo run args (pass after `--`)."),
    Argument.variadic(),
  ),
}).pipe(
  Command.withDescription("Run monorepo development modes with deterministic port/env wiring."),
  Command.withHandler((input) => runDevRunnerWithInput(input)),
);

if (import.meta.main) {
  Command.run(devRunnerCli, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer)),
    NodeRuntime.runMain,
  );
}
