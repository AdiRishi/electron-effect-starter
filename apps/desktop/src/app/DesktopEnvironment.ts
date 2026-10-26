import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type { ElectronAppMetadata } from "../electron/ElectronApp.ts";
import { DesktopConfig } from "./DesktopConfig.ts";

const APP_USER_MODEL_ID = "com.example.electron-effect-starter";

function resolveUserDataPath(input: {
  readonly appDataDirectory: string;
  readonly isDevelopment: boolean;
  readonly productName: string;
  readonly joinPath: (...segments: ReadonlyArray<string>) => string;
}): string {
  return input.joinPath(
    input.appDataDirectory,
    input.isDevelopment ? `${input.productName} (Dev)` : input.productName,
  );
}

export interface MakeDesktopEnvironmentInput {
  readonly dirname: string;
  readonly platform: NodeJS.Platform;
  readonly productName: string;
  readonly metadata: ElectronAppMetadata;
}

/** Paths and modes resolved once at startup from Electron's metadata and the environment. */
export class DesktopEnvironment extends Context.Service<
  DesktopEnvironment,
  {
    readonly platform: NodeJS.Platform;
    readonly isPackaged: boolean;
    readonly isDevelopment: boolean;
    readonly appVersion: string;
    readonly displayName: string;
    readonly appUserModelId: string;
    readonly userDataPath: string;
    readonly stateDir: string;
    readonly serverBaseDir: string;
    readonly logDir: string;
    readonly desktopSettingsPath: string;
    readonly appRoot: string;
    readonly resourcesPath: string;
    readonly backendEntryPath: string;
    readonly clientAssetsDir: string;
    readonly preloadPath: string;
    readonly compileCachePath: string;
    readonly appUpdateYmlPath: string;
    readonly devServerUrl: Option.Option<URL>;
    readonly configuredBackendPort: Option.Option<number>;
    readonly appImagePath: Option.Option<string>;
    readonly disableAutoUpdate: boolean;
  }
>()("@app/desktop/app/DesktopEnvironment") {}

export const make = Effect.fn("DesktopEnvironment.make")(function* (
  input: MakeDesktopEnvironmentInput,
): Effect.fn.Return<DesktopEnvironment["Service"], Config.ConfigError, Path.Path> {
  const path = yield* Path.Path;
  const config = yield* DesktopConfig;
  const isDevelopment = Option.isSome(config.devServerUrl);

  // Development gets its own userData, so its state, profile and instance lock never touch the
  // installed app's.
  const userDataPath = resolveUserDataPath({
    appDataDirectory: input.metadata.appDataPath,
    isDevelopment,
    productName: input.productName,
    joinPath: path.join,
  });

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
    appUserModelId: isDevelopment ? `${APP_USER_MODEL_ID}.dev` : APP_USER_MODEL_ID,
    userDataPath,
    stateDir: userDataPath,
    serverBaseDir: path.join(userDataPath, "server"),
    logDir: path.join(userDataPath, "logs"),
    desktopSettingsPath: path.join(userDataPath, "desktop-settings.json"),
    appRoot,
    resourcesPath: input.metadata.resourcesPath,
    backendEntryPath: path.join(appRoot, "apps/server/dist/bin.mjs"),
    clientAssetsDir: path.join(appRoot, "apps/server/dist/client"),
    preloadPath: path.join(input.dirname, "preload.cjs"),
    compileCachePath: path.join(input.dirname, "compileCache.cjs"),
    appUpdateYmlPath: input.metadata.isPackaged
      ? path.join(input.metadata.resourcesPath, "app-update.yml")
      : path.join(input.metadata.appPath, "dev-app-update.yml"),
    devServerUrl: config.devServerUrl,
    configuredBackendPort: config.configuredBackendPort,
    appImagePath: config.appImagePath,
    disableAutoUpdate: config.disableAutoUpdate,
  });
});

export const layer = (input: MakeDesktopEnvironmentInput) =>
  Layer.effect(DesktopEnvironment, make(input));
