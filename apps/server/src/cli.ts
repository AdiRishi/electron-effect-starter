import { PortSchema } from "@app/contracts";
import * as HostProcess from "@app/shared/HostProcess";
import * as NetService from "@app/shared/Net";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import type * as LogLevel from "effect/LogLevel";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";

import { readBootstrapEnvelope } from "./bootstrap.ts";
import * as ServerConfig from "./config.ts";
import { awaitLauncherLoss } from "./launcherWatch.ts";
import { runServer } from "./server.ts";

const flags = {
  mode: Flag.Literals("mode", ServerConfig.RuntimeMode.literals).pipe(
    Flag.withDescription("Runtime mode. `desktop` is set by the Electron shell."),
    Flag.optional,
  ),
  port: Flag.Int("port").pipe(
    Flag.withSchema(PortSchema),
    Flag.withDescription("Port for the HTTP/WebSocket server."),
    Flag.optional,
  ),
  host: Flag.String("host").pipe(
    Flag.withDescription("Interface to bind. Defaults to 127.0.0.1."),
    Flag.optional,
  ),
  baseDir: Flag.String("base-dir").pipe(
    Flag.withDescription("Data directory; runtime state lives below it (equivalent to APP_HOME)."),
    Flag.optional,
  ),
  devUrl: Flag.String("dev-url").pipe(
    Flag.withSchema(Schema.URLFromString),
    Flag.withDescription("Vite dev server URL to redirect page loads to (VITE_DEV_SERVER_URL)."),
    Flag.optional,
  ),
  bootstrapFd: Flag.Int("bootstrap-fd").pipe(
    Flag.withDescription("Read the desktop bootstrap envelope from this file descriptor."),
    Flag.optional,
  ),
} as const;

type ServerFlags = Command.Command.Config.Infer<typeof flags>;

const EnvConfig = Config.all({
  logLevel: Config.LogLevel("APP_LOG_LEVEL").pipe(Config.withDefault("Info")),
  mode: Config.schema(ServerConfig.RuntimeMode, "APP_MODE").pipe(Config.option),
  port: Config.Port("APP_PORT").pipe(Config.option),
  host: Config.String("APP_HOST").pipe(Config.option),
  baseDir: Config.String("APP_HOME").pipe(Config.option),
  devUrl: Config.URL("VITE_DEV_SERVER_URL").pipe(Config.option),
  bootstrapFd: Config.Int("APP_BOOTSTRAP_FD").pipe(Config.option),
});

const expandHomePath = Effect.fn("cli.expandHomePath")(function* (input: string) {
  const { join, resolve } = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;

  if (input === "~") return home;

  if (input.startsWith("~/") || input.startsWith("~\\")) return join(home, input.slice(2));

  return resolve(input);
});

/** Precedence is flag, then environment, then the desktop bootstrap envelope, then a default. */
export const resolveServerConfig = Effect.fn("cli.resolveServerConfig")(function* (
  serverFlags: ServerFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
) {
  const net = yield* NetService.NetService;
  const path = yield* Path.Path;
  const env = yield* EnvConfig;

  const bootstrapFd = Option.firstSomeOf([serverFlags.bootstrapFd, env.bootstrapFd]);

  const bootstrap = Option.isSome(bootstrapFd)
    ? Option.getOrUndefined(yield* readBootstrapEnvelope(bootstrapFd.value))
    : undefined;

  const mode = Option.getOrElse(
    Option.firstSomeOf([serverFlags.mode, env.mode, Option.fromUndefinedOr(bootstrap?.mode)]),
    (): ServerConfig.RuntimeMode => "web",
  );

  const explicitPort = Option.firstSomeOf([
    serverFlags.port,
    env.port,
    Option.fromUndefinedOr(bootstrap?.port),
  ]);

  const port = Option.isSome(explicitPort)
    ? explicitPort.value
    : yield* net.findAvailablePort(ServerConfig.DEFAULT_PORT);

  const devUrl = Option.getOrUndefined(Option.firstSomeOf([serverFlags.devUrl, env.devUrl]));

  const rawBaseDir = Option.firstSomeOf([
    serverFlags.baseDir,
    env.baseDir,
    Option.fromUndefinedOr(bootstrap?.baseDir),
  ]).pipe(Option.filter((value) => value.trim().length > 0));

  const baseDir = Option.isSome(rawBaseDir)
    ? yield* expandHomePath(rawBaseDir.value.trim())
    : path.join(yield* HostProcess.HomeDirectory, ServerConfig.DATA_DIR_NAME);

  const paths = yield* ServerConfig.deriveServerPaths(baseDir, devUrl);
  yield* ServerConfig.ensureServerDirectories(paths);

  return ServerConfig.ServerConfig.of({
    ...paths,
    logLevel: Option.getOrElse(cliLogLevel, () => env.logLevel),
    mode,
    port,
    host: Option.getOrElse(
      Option.firstSomeOf([serverFlags.host, env.host, Option.fromUndefinedOr(bootstrap?.host)]),
      () => ServerConfig.DEFAULT_HOST,
    ),
    baseDir,
    staticDir: devUrl === undefined ? yield* ServerConfig.resolveStaticDir() : undefined,
    devUrl,
    desktopBootstrapToken: bootstrap?.desktopBootstrapToken,
  });
});

// The desktop shell reads this process's stdout and stderr. Once it is gone every log write fails,
// and Node turns an unhandled stream error into a crash that skips shutdown.
function ignoreClosedLauncherPipe(error: NodeJS.ErrnoException): void {
  if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") throw error;
}

const runServerCommand = Effect.fn("cli.runServerCommand")(function* (serverFlags: ServerFlags) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveServerConfig(serverFlags, logLevel);
  const run = runServer.pipe(Effect.provideService(ServerConfig.ServerConfig, config));

  if (config.mode !== "desktop") return yield* run;
  yield* Effect.sync(() => {
    process.stdout.on("error", ignoreClosedLauncherPipe);
    process.stderr.on("error", ignoreClosedLauncherPipe);
  });

  return yield* Effect.raceFirst(
    run,
    // End like SIGTERM does: an interrupt-only exit lets the runtime run finalizers and exit.
    awaitLauncherLoss().pipe(Effect.andThen(Effect.interrupt)),
  );
});

export const cli = Command.make("server", flags).pipe(
  Command.withDescription("Run the local HTTP and WebSocket RPC server."),
  Command.withHandler(runServerCommand),
);
