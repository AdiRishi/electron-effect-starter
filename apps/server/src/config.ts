/**
 * ServerConfig - runtime configuration for the starter server.
 *
 * The whole server bottoms out at this single service. It is resolved once at
 * startup from environment variables + the bootstrap envelope, then provided as
 * a `Layer.succeed` value that every other layer reads.
 *
 * @module ServerConfig
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

export const DEFAULT_PORT = 13773;
export const DEFAULT_HOST = "127.0.0.1";
export const APP_NAME = "Desktop Starter";

/**
 * ServerConfig - service tag for the resolved server runtime configuration.
 */
export class ServerConfig extends Context.Service<
  ServerConfig,
  {
    readonly appName: string;
    readonly version: string;
    /** Unix millis the process resolved config / started up. */
    readonly startedAt: number;
    readonly host: string;
    readonly port: number;
    /** Built web assets to serve, or `undefined` when only a dev URL is set. */
    readonly staticDir: string | undefined;
    /** When set, navigations are 302-redirected here (dev). */
    readonly devWebUrl: URL | undefined;
    /** The shared secret a client exchanges for a bearer token. */
    readonly bootstrapToken: string;
  }
>()("@app/server/config/ServerConfig") {}

export const make = (config: ServerConfig["Service"]) => ServerConfig.of(config);

export const layer = (config: ServerConfig["Service"]) => Layer.succeed(ServerConfig, make(config));

/**
 * Resolve the directory of built web assets. Prefers the bundled `dist/client`
 * (packaged) and falls back to `../web/dist` (monorepo dev). Returns `undefined`
 * when neither exists.
 */
export const resolveStaticDir = Effect.fn("ServerConfig.resolveStaticDir")(function* () {
  const { join, resolve } = yield* Path.Path;
  const { exists } = yield* FileSystem.FileSystem;

  const bundledClient = resolve(join(import.meta.dirname, "client"));
  const hasBundled = yield* exists(join(bundledClient, "index.html")).pipe(
    Effect.orElseSucceed(() => false),
  );
  if (hasBundled) {
    return bundledClient;
  }

  const monorepoClient = resolve(join(import.meta.dirname, "../../web/dist"));
  const hasMonorepo = yield* exists(join(monorepoClient, "index.html")).pipe(
    Effect.orElseSucceed(() => false),
  );
  if (hasMonorepo) {
    return monorepoClient;
  }

  return undefined;
});
