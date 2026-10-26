import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopEnvironment from "../../src/app/DesktopEnvironment.ts";

export const testEnvironment = (
  overrides: Partial<DesktopEnvironment.DesktopEnvironment["Service"]> = {},
): DesktopEnvironment.DesktopEnvironment["Service"] =>
  DesktopEnvironment.DesktopEnvironment.of({
    platform: "linux",
    isPackaged: false,
    isDevelopment: false,
    appVersion: "1.2.3",
    displayName: "Test",
    appUserModelId: "com.example.test",
    userDataPath: "/data",
    stateDir: "/data",
    serverBaseDir: "/data/server",
    logDir: "/data/logs",
    desktopSettingsPath: "/data/desktop-settings.json",
    appRoot: "/app",
    resourcesPath: "/app/resources",
    backendEntryPath: "/app/apps/server/dist/bin.mjs",
    clientAssetsDir: "/app/apps/server/dist/client",
    preloadPath: "/app/preload.cjs",
    compileCachePath: "/app/compileCache.cjs",
    appUpdateYmlPath: "/app/resources/app-update.yml",
    devServerUrl: Option.none(),
    configuredBackendPort: Option.none(),
    appImagePath: Option.none(),
    disableAutoUpdate: false,
    ...overrides,
  });

export const layerTestEnvironment = (
  overrides: Partial<DesktopEnvironment.DesktopEnvironment["Service"]> = {},
) => Layer.succeed(DesktopEnvironment.DesktopEnvironment, testEnvironment(overrides));
