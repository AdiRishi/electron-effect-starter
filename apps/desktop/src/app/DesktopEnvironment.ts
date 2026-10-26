import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import * as Path from "effect/Path";

import type { ElectronAppMetadata } from "../electron/ElectronApp.ts";
import { DesktopConfig } from "./DesktopConfig.ts";

/** Paths and modes resolved once at startup from Electron's metadata and the environment. */
export class DesktopEnvironment extends Context.Service<
  DesktopEnvironment,
  {
    readonly platform: NodeJS.Platform;
    readonly isPackaged: boolean;
    readonly isDevelopment: boolean;
    readonly appVersion: string;
    readonly displayName: string;
    readonly stateDir: string;
    readonly serverBaseDir: string;
    readonly logDir: string;
    readonly appRoot: string;
    readonly backendEntryPath: string;
    readonly clientAssetsDir: string;
    readonly preloadPath: string;
    readonly compileCachePath: string;
    readonly devServerUrl: Option.Option<URL>;
    readonly configuredBackendPort: Option.Option<number>;
    readonly disableAutoUpdate: boolean;
  }
>()("@app/desktop/app/DesktopEnvironment") {}

export const make = Effect.fn("DesktopEnvironment.make")(function* (input: {
  readonly dirname: string;
  readonly platform: NodeJS.Platform;
  readonly productName: string;
  readonly metadata: ElectronAppMetadata;
}) {
  const path = yield* Path.Path;
  const config = yield* DesktopConfig;
  const isDevelopment = config.devServerUrl._tag === "Some";
  // Dev builds keep separate state so they never migrate the installed app's database.
  const stateDir = isDevelopment
    ? path.join(input.metadata.userDataPath, "dev")
    : input.metadata.userDataPath;
  // dist-electron sits three levels below the repository root in a source checkout.
  const appRoot = input.metadata.isPackaged
    ? input.metadata.appPath
    : path.resolve(input.dirname, "../../..");

  return DesktopEnvironment.of({
    platform: input.platform,
    isPackaged: input.metadata.isPackaged,
    isDevelopment,
    appVersion: input.metadata.appVersion,
    displayName: isDevelopment ? `${input.productName} (Dev)` : input.productName,
    stateDir,
    serverBaseDir: path.join(stateDir, "server"),
    logDir: path.join(stateDir, "logs"),
    appRoot,
    backendEntryPath: path.join(appRoot, "apps/server/dist/bin.mjs"),
    clientAssetsDir: path.join(appRoot, "apps/server/dist/client"),
    preloadPath: path.join(input.dirname, "preload.cjs"),
    compileCachePath: path.join(input.dirname, "compileCache.cjs"),
    devServerUrl: config.devServerUrl,
    configuredBackendPort: config.configuredBackendPort,
    disableAutoUpdate: config.disableAutoUpdate,
  });
});

export const layer = (input: Parameters<typeof make>[0]) =>
  Layer.effect(DesktopEnvironment, make(input));
