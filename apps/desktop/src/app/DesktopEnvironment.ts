import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type { DesktopAppInfo } from "@app/contracts";

import type { DesktopSettings } from "../settings/DesktopAppSettings.ts";
import { DEFAULT_DESKTOP_SETTINGS } from "../settings/DesktopAppSettings.ts";

// All the derived, environment-dependent facts the rest of the shell reads:
// paths, dev-vs-prod, branding, and where the server entry lives. It is built
// once in `main.ts` from injected Electron metadata + host process values, so
// every consumer sees the same resolved values and nothing downstream touches
// `process`/`__dirname` directly.
//
// ── DESIGN SEAM (branding + paths) ──
// The app name, port default, and path layout are all decided here. Change them
// in one place and the window title, settings location, and log dir follow.

const APP_BASE_NAME = "App";
const DEFAULT_BACKEND_PORT = 13773;

export interface MakeDesktopEnvironmentInput {
  /** `__dirname` of the built main.cjs (dist-electron). */
  readonly dirname: string;
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly appVersion: string;
  readonly appPath: string;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  /** `APP_SERVER_ENTRY` override, if set. */
  readonly serverEntryOverride: Option.Option<string>;
  /** `APP_SERVER_PORT`, if set. */
  readonly configuredBackendPort: Option.Option<number>;
  /** `APP_DEV_WEB_URL` dev-server URL, if set (renderer served here in dev). */
  readonly devServerUrl: Option.Option<URL>;
}

export class DesktopEnvironment extends Context.Service<
  DesktopEnvironment,
  {
    readonly path: Path.Path;
    readonly platform: DesktopAppInfo["platform"];
    readonly isPackaged: boolean;
    readonly isDevelopment: boolean;
    readonly appVersion: string;
    readonly appPath: string;
    readonly resourcesPath: string;
    readonly homeDirectory: string;
    /** Base app-data dir, e.g. ~/.app-starter — settings + logs live under here. */
    readonly baseDir: string;
    readonly desktopSettingsPath: string;
    readonly logDir: string;
    readonly preloadPath: string;
    /** Absolute path to the server entry to spawn. */
    readonly backendEntryPath: string;
    /** cwd for the spawned server child. */
    readonly backendCwd: string;
    readonly defaultBackendPort: number;
    readonly configuredBackendPort: Option.Option<number>;
    readonly devServerUrl: Option.Option<URL>;
    /** Static identity handed to the renderer at boot. */
    readonly appInfo: DesktopAppInfo;
    readonly displayName: string;
    readonly defaultDesktopSettings: DesktopSettings;
  }
>()("@app/desktop/app/DesktopEnvironment") {}

function normalizePlatform(
  platform: NodeJS.Platform,
): DesktopAppInfo["platform"] {
  if (platform === "win32") return "win32";
  if (platform === "darwin") return "darwin";
  return "linux";
}

// The Path service is taken explicitly so this builder stays pure and
// testable — the `layer` below wires the real `Path.Path` in.
export function makeWith(
  input: MakeDesktopEnvironmentInput,
  path: Path.Path,
): DesktopEnvironment["Service"] {
  const platform = normalizePlatform(input.platform);
  const isDevelopment = Option.isSome(input.devServerUrl);
  const stageLabel = isDevelopment ? "Dev" : "Alpha";
  const displayName = `${APP_BASE_NAME} (${stageLabel})`;

  const baseDir = path.join(input.homeDirectory, ".app-starter");
  const logDir = path.join(baseDir, "logs");
  const desktopSettingsPath = path.join(baseDir, "desktop-settings.json");
  const preloadPath = path.join(input.dirname, "preload.cjs");

  // Resolve the server entry to spawn. Priority:
  //   1. APP_SERVER_ENTRY override (used by the dev runner).
  //   2. Packaged: the bundled server at resources/app/apps/server/dist/bin.mjs.
  //   3. Dev default: the server's built dist relative to this monorepo.
  // The dev runner points APP_SERVER_ENTRY at the server's src/bin.ts (run via
  // tsx) or its built dist/bin.mjs, so most local setups exercise branch (1).
  const backendEntryPath = Option.match(input.serverEntryOverride, {
    onSome: (override) => override,
    onNone: () =>
      input.isPackaged
        ? path.join(
            input.resourcesPath,
            "app",
            "apps",
            "server",
            "dist",
            "bin.mjs",
          )
        : path.resolve(input.dirname, "..", "..", "server", "dist", "bin.mjs"),
  });
  const backendCwd = path.dirname(backendEntryPath);

  const appInfo: DesktopAppInfo = {
    name: displayName,
    version: input.appVersion,
    platform,
    isPackaged: input.isPackaged,
  };

  return DesktopEnvironment.of({
    path,
    platform,
    isPackaged: input.isPackaged,
    isDevelopment,
    appVersion: input.appVersion,
    appPath: input.appPath,
    resourcesPath: input.resourcesPath,
    homeDirectory: input.homeDirectory,
    baseDir,
    desktopSettingsPath,
    logDir,
    preloadPath,
    backendEntryPath,
    backendCwd,
    defaultBackendPort: DEFAULT_BACKEND_PORT,
    configuredBackendPort: input.configuredBackendPort,
    devServerUrl: input.devServerUrl,
    appInfo,
    displayName,
    defaultDesktopSettings: DEFAULT_DESKTOP_SETTINGS,
  });
}

// Reads the `APP_SERVER_ENTRY` / `APP_SERVER_PORT` / `APP_DEV_WEB_URL` env
// config (via Effect's Config, so it's overridable in tests) and builds it.
export function layer(
  metadata: Pick<
    MakeDesktopEnvironmentInput,
    | "dirname"
    | "homeDirectory"
    | "platform"
    | "appVersion"
    | "appPath"
    | "isPackaged"
    | "resourcesPath"
  >,
): Layer.Layer<DesktopEnvironment> {
  return Layer.effect(
    DesktopEnvironment,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serverEntryOverride = yield* Config.string("APP_SERVER_ENTRY").pipe(
        Config.option,
      );
      const configuredBackendPort = yield* Config.port("APP_SERVER_PORT").pipe(
        Config.option,
      );
      const devServerUrl = yield* Config.url("APP_DEV_WEB_URL").pipe(
        Config.option,
      );
      return makeWith(
        {
          ...metadata,
          serverEntryOverride,
          configuredBackendPort,
          devServerUrl,
        },
        path,
      );
      // A malformed env value (e.g. a non-URL APP_DEV_WEB_URL) is a startup
      // misconfiguration; die rather than thread ConfigError through the graph.
    }).pipe(Effect.orDie),
  ).pipe(Layer.provide(Path.layer));
}
