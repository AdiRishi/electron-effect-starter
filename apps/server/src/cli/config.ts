/**
 * CLI → ServerConfig resolution.
 *
 * Resolves the fully-materialized `ServerConfig` from (in precedence order)
 * command flags, the bootstrap envelope, and environment variables. The
 * bootstrap token comes from: `--bootstrap-fd` envelope, else `APP_BOOTSTRAP_TOKEN`,
 * else a freshly generated random token (logged, for dev convenience).
 *
 * @module cli/config
 */
import { HostProcessEnvironment } from "@app/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Argument, Flag } from "effect/unstable/cli";

import { readBootstrapEnvelope } from "../bootstrap.ts";
import * as ServerConfig from "../config.ts";

const APP_VERSION = "0.0.0";

export const portFlag = Flag.integer("port").pipe(
  Flag.withDescription("Port for the HTTP/WebSocket server (default 13773 or APP_SERVER_PORT)."),
  Flag.optional,
);
export const hostFlag = Flag.string("host").pipe(
  Flag.withDescription("Host/interface to bind (default 127.0.0.1)."),
  Flag.optional,
);
export const devWebUrlFlag = Flag.string("dev-web-url").pipe(
  Flag.withDescription("Dev web URL to redirect navigations to (equivalent to APP_DEV_WEB_URL)."),
  Flag.optional,
);
export const bootstrapFdFlag = Flag.integer("bootstrap-fd").pipe(
  Flag.withDescription("Read the one-time bootstrap envelope from the given file descriptor."),
  Flag.optional,
);

export const sharedServerCommandFlags = {
  port: portFlag,
  host: hostFlag,
  devWebUrl: devWebUrlFlag,
  bootstrapFd: bootstrapFdFlag,
  cwd: Argument.string("cwd").pipe(
    Argument.withDescription("Working directory (defaults to the current directory)."),
    Argument.optional,
  ),
} as const;

export interface CliServerFlags {
  readonly port: Option.Option<number>;
  readonly host: Option.Option<string>;
  readonly devWebUrl: Option.Option<string>;
  readonly bootstrapFd: Option.Option<number>;
  readonly cwd: Option.Option<string>;
}

const parseUrlOption = (value: string | undefined): URL | undefined => {
  if (value === undefined || value.trim().length === 0) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

const parsePortOption = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : undefined;
};

/** Resolve the full server config from flags + bootstrap envelope + env. */
export const resolveServerConfig = Effect.fn("cli.resolveServerConfig")(function* (
  flags: CliServerFlags,
) {
  const env = yield* HostProcessEnvironment;
  const crypto = yield* Crypto.Crypto;
  const startedAt = yield* Clock.currentTimeMillis;

  const bootstrapFd = Option.getOrUndefined(flags.bootstrapFd);
  const bootstrapEnvelope =
    bootstrapFd !== undefined
      ? yield* readBootstrapEnvelope(bootstrapFd)
      : Option.none<{ desktopBootstrapToken: string; port?: number }>();
  const bootstrap = Option.getOrUndefined(bootstrapEnvelope);

  const port =
    Option.getOrUndefined(flags.port) ??
    bootstrap?.port ??
    parsePortOption(env["APP_SERVER_PORT"]) ??
    ServerConfig.DEFAULT_PORT;

  const host = Option.getOrUndefined(flags.host) ?? env["APP_SERVER_HOST"] ?? ServerConfig.DEFAULT_HOST;

  const devWebUrl =
    parseUrlOption(Option.getOrUndefined(flags.devWebUrl)) ?? parseUrlOption(env["APP_DEV_WEB_URL"]);

  // No dev URL → resolve built static assets (undefined until the web is built).
  const staticDir = devWebUrl ? undefined : yield* ServerConfig.resolveStaticDir();

  // Bootstrap token precedence: envelope → env → generated (dev convenience).
  let bootstrapToken = bootstrap?.desktopBootstrapToken ?? env["APP_BOOTSTRAP_TOKEN"];
  if (bootstrapToken === undefined || bootstrapToken.trim().length === 0) {
    const bytes = yield* crypto.randomBytes(32).pipe(Effect.orDie);
    bootstrapToken = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    yield* Effect.logInfo("generated bootstrap token (dev)", { bootstrapToken });
  }

  return ServerConfig.make({
    appName: ServerConfig.APP_NAME,
    version: APP_VERSION,
    startedAt,
    host,
    port,
    staticDir,
    devWebUrl,
    bootstrapToken,
  });
});
