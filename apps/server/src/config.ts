import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as LogLevel from "effect/LogLevel";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const DEFAULT_PORT = 3773;
export const DEFAULT_HOST = "127.0.0.1";
export const DATA_DIR_NAME = ".electron-effect-starter";

export const RuntimeMode = Schema.Literals(["web", "desktop"]);

export type RuntimeMode = typeof RuntimeMode.Type;

export interface ServerDerivedPaths {
  readonly stateDir: string;
  readonly dbPath: string;
  readonly secretsDir: string;
}

export class ServerConfig extends Context.Service<
  ServerConfig,
  ServerDerivedPaths & {
    readonly logLevel: LogLevel.LogLevel;
    readonly mode: RuntimeMode;
    readonly port: number;
    readonly host: string;
    readonly baseDir: string;
    readonly staticDir: string | undefined;
    readonly devUrl: URL | undefined;
    /** Log every HTTP request and WebSocket upgrade; on by default behind the Vite dev server. */
    readonly logWebSocketEvents: boolean;
    readonly desktopBootstrapToken: string | undefined;
  }
>()("@app/server/config/ServerConfig") {}

export interface DeriveServerPathsOptions {
  readonly baseDirIsExplicit?: boolean;
}

export const deriveServerPaths = Effect.fn("ServerConfig.deriveServerPaths")(function* (
  baseDir: string,
  devUrl: URL | undefined,
  options: DeriveServerPathsOptions = {},
): Effect.fn.Return<ServerDerivedPaths, never, Path.Path> {
  const { join } = yield* Path.Path;

  // Dev servers keep their own state so a dev build never migrates the packaged app's database.
  // A base directory named on the command line or in APP_HOME is already separate; use it as given.
  const stateDir = join(
    baseDir,
    devUrl !== undefined && !options.baseDirIsExplicit ? "dev" : "userdata",
  );

  return {
    stateDir,
    dbPath: join(stateDir, "state.sqlite"),
    secretsDir: join(stateDir, "secrets"),
  };
});

export const ensureServerDirectories = Effect.fn("ServerConfig.ensureServerDirectories")(function* (
  paths: ServerDerivedPaths,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(paths.stateDir, { recursive: true });
  yield* fs.makeDirectory(paths.secretsDir, { recursive: true });
});

/** The bundled server serves `dist/client`; a source checkout serves the web app's own build. */
export const resolveStaticDir = Effect.fn("ServerConfig.resolveStaticDir")(function* () {
  const { join, resolve } = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  const candidates = [
    resolve(join(import.meta.dirname, "client")),
    resolve(join(import.meta.dirname, "../../web/dist")),
  ];

  for (const candidate of candidates) {
    if (yield* fs.exists(join(candidate, "index.html")).pipe(Effect.orElseSucceed(() => false))) {
      return candidate;
    }
  }

  return undefined;
});

export const layerTest = (options?: {
  readonly desktopBootstrapToken?: string | undefined;
  readonly staticDir?: string | undefined;
}) =>
  Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      // macOS temp dirs live under the /var -> /private/var symlink; keep generated paths real.
      const baseDir = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "app-server-test-" }),
      );

      const paths = yield* deriveServerPaths(baseDir, undefined);
      yield* ensureServerDirectories(paths);

      return ServerConfig.of({
        ...paths,
        logLevel: "Error",
        mode: options?.desktopBootstrapToken === undefined ? "web" : "desktop",
        port: 0,
        host: DEFAULT_HOST,
        baseDir,
        staticDir: options?.staticDir,
        devUrl: undefined,
        logWebSocketEvents: false,
        desktopBootstrapToken: options?.desktopBootstrapToken,
      });
    }),
  );
