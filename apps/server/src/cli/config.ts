// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Flag } from "effect/unstable/cli";

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
import { Port } from "@app/contracts";
import { HostProcessEnvironment } from "@app/shared/hostProcess";

import { type BootstrapEnvelope, readBootstrapEnvelope } from "../bootstrap.ts";
import * as ServerConfig from "../config.ts";

export const portFlag = Flag.integer("port").pipe(
  Flag.withSchema(Port),
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
} as const;

export interface CliServerFlags {
  readonly port: Option.Option<number>;
  readonly host: Option.Option<string>;
  readonly devWebUrl: Option.Option<string>;
  readonly bootstrapFd: Option.Option<number>;
}

const parseUrlOption = (value: string | undefined): URL | undefined => {
  if (value === undefined || value.trim().length === 0) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

// Bounds match the contracts `Port` schema (1–65535); port 0 would bind an
// ephemeral port that no client could discover.
const parsePortOption = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : undefined;
};

/** Resolve the full server config from flags + bootstrap envelope + env. */
export const resolveServerConfig = Effect.fn("cli.resolveServerConfig")(function* (
  flags: CliServerFlags,
  options?: {
    timeoutMs?: number;
  },
) {
  const env = yield* HostProcessEnvironment;
  const crypto = yield* Crypto.Crypto;
  const startedAt = yield* DateTime.now;

  const bootstrapFd = Option.getOrUndefined(flags.bootstrapFd);
  const bootstrapEnvelope =
    bootstrapFd !== undefined
      ? yield* readBootstrapEnvelope(bootstrapFd, options)
      : Option.none<BootstrapEnvelope>();
  const bootstrap = Option.getOrUndefined(bootstrapEnvelope);

  const port =
    Option.getOrUndefined(flags.port) ??
    bootstrap?.port ??
    parsePortOption(env["APP_SERVER_PORT"]) ??
    ServerConfig.DEFAULT_PORT;

  const host =
    Option.getOrUndefined(flags.host) ?? env["APP_SERVER_HOST"] ?? ServerConfig.DEFAULT_HOST;

  const devWebUrl =
    parseUrlOption(Option.getOrUndefined(flags.devWebUrl)) ??
    parseUrlOption(env["APP_DEV_WEB_URL"]);

  // No dev URL → resolve built static assets (undefined until the web is built).
  const staticDir = devWebUrl ? undefined : yield* ServerConfig.resolveStaticDir();

  // Same directory the desktop shell uses as its app-data base, so the server
  // persists to one place whether it was spawned by the shell or standalone.
  const dataDir =
    env["APP_DATA_DIR"] ?? NodePath.join(NodeOS.homedir(), ".electron-effect-starter");

  // Bootstrap token precedence: envelope → env → generated (dev convenience).
  let bootstrapToken = bootstrap?.desktopBootstrapToken ?? env["APP_BOOTSTRAP_TOKEN"];
  if (bootstrapToken === undefined || bootstrapToken.trim().length === 0) {
    const bytes = yield* crypto.randomBytes(32).pipe(Effect.orDie);
    bootstrapToken = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    yield* Effect.logInfo("generated bootstrap token (dev)", {
      bootstrapToken,
    });
  }

  return ServerConfig.make({
    appName: ServerConfig.APP_NAME,
    version: ServerConfig.APP_VERSION,
    startedAt,
    host,
    port,
    staticDir,
    devWebUrl,
    bootstrapToken,
    dataDir,
  });
});
