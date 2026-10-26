import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopLogger from "../app/DesktopLogger.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopBackend from "../backend/DesktopBackend.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";

const CHECK_INTERVAL = "4 hours";
const INSTALL_BACKEND_STOP_TIMEOUT = Duration.seconds(5);

const { logInfo, logWarning, logError } = DesktopLogger.forComponent("desktop-updates");

const AppUpdateYmlConfig = Schema.Record(Schema.String, Schema.String);

type AppUpdateYmlConfig = typeof AppUpdateYmlConfig.Type;

const decodeAppUpdateYmlConfig = Schema.decodeUnknownEffect(AppUpdateYmlConfig);

/** What a check found, read once the updater has answered it. */
export type DesktopUpdateCheckResult =
  | { readonly status: "up-to-date"; readonly currentVersion: string }
  | { readonly status: "available"; readonly version: string }
  | { readonly status: "error"; readonly message: string };

/**
 * Checks for updates in packaged builds, downloads them in the background, and offers a restart
 * once one is ready; an update not installed then is applied on the next quit.
 */
export class DesktopUpdates extends Context.Service<
  DesktopUpdates,
  {
    readonly configure: Effect.Effect<void, never, Scope.Scope>;
    readonly disabledReason: Effect.Effect<Option.Option<string>>;
    readonly check: Effect.Effect<DesktopUpdateCheckResult>;
    readonly install: Effect.Effect<void>;
  }
>()("@app/desktop/updates/DesktopUpdates") {}

function parseAppUpdateYml(raw: string): Effect.Effect<Option.Option<AppUpdateYmlConfig>> {
  const entries: Record<string, string> = {};

  for (const line of raw.split("\n")) {
    const match = line.match(/^(\w+):\s*(.+)$/);

    if (match?.[1] && match[2]) {
      entries[match[1]] = match[2].trim();
    }
  }

  return decodeAppUpdateYmlConfig(entries).pipe(
    Effect.map((config) => (config.provider ? Option.some(config) : Option.none())),
    Effect.orElseSucceed(() => Option.none<AppUpdateYmlConfig>()),
  );
}

function getAutoUpdateDisabledReason(args: {
  isDevelopment: boolean;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  appImage?: string | undefined;
  isDebPackage: boolean;
  disabledByEnv: boolean;
  hasUpdateFeedConfig: boolean;
}): string | null {
  if (!args.hasUpdateFeedConfig) {
    return "Automatic updates are not available because no update feed is configured.";
  }

  if (args.isDevelopment || !args.isPackaged) {
    return "Automatic updates are only available in packaged production builds.";
  }

  if (args.disabledByEnv) {
    return "Automatic updates are disabled by the APP_DISABLE_AUTO_UPDATE setting.";
  }

  if (args.platform === "linux" && !args.appImage && !args.isDebPackage) {
    return "Automatic updates on Linux require the AppImage or the .deb package.";
  }

  return null;
}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopState = yield* DesktopState.DesktopState;
  const backend = yield* DesktopBackend.DesktopBackend;
  const updater = yield* ElectronUpdater.ElectronUpdater;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const runSync = Effect.runSyncWith(context);
  const appUpdateYmlConfigRef = yield* Ref.make(Option.none<AppUpdateYmlConfig>());
  const updaterConfiguredRef = yield* Ref.make(false);
  const lastCheckResultRef = yield* Ref.make(Option.none<DesktopUpdateCheckResult>());
  // The server's desired state before an install stopped it, so a failed install can restore it.
  const installRef = yield* Ref.make(Option.none<{ readonly backendWasRunning: boolean }>());

  const readAppUpdateYml = fileSystem.readFileString(environment.appUpdateYmlPath, "utf-8").pipe(
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<AppUpdateYmlConfig>()),
        onSome: parseAppUpdateYml,
      }),
    ),
  );

  // electron-updater uses this marker to install .deb updates with dpkg.
  const isDebPackage =
    environment.platform === "linux" && environment.isPackaged
      ? yield* fileSystem.readFileString(path.join(environment.resourcesPath, "package-type")).pipe(
          Effect.map((packageType) => packageType.trim() === "deb"),
          Effect.orElseSucceed(() => false),
        )
      : false;

  const disabledReason = Ref.get(appUpdateYmlConfigRef).pipe(
    Effect.map((appUpdateYmlConfig) =>
      Option.fromNullishOr(
        getAutoUpdateDisabledReason({
          isDevelopment: environment.isDevelopment,
          isPackaged: environment.isPackaged,
          platform: environment.platform,
          appImage: Option.getOrUndefined(environment.appImagePath),
          isDebPackage,
          disabledByEnv: environment.disableAutoUpdate,
          hasUpdateFeedConfig: Option.isSome(appUpdateYmlConfig),
        }),
      ),
    ),
  );

  const check = Effect.gen(function* () {
    if (!(yield* Ref.get(updaterConfiguredRef))) {
      return {
        status: "error",
        message: Option.getOrElse(yield* disabledReason, () => "Updates are not configured."),
      } satisfies DesktopUpdateCheckResult;
    }

    yield* Ref.set(lastCheckResultRef, Option.none());

    // electron-updater emits the check's outcome before its promise settles.
    return yield* updater.checkForUpdates.pipe(
      Effect.andThen(Ref.get(lastCheckResultRef)),
      Effect.map(
        Option.getOrElse((): DesktopUpdateCheckResult => ({
          status: "up-to-date",
          currentVersion: environment.appVersion,
        })),
      ),
      Effect.catchTags({
        ElectronUpdaterCheckError: (error) =>
          logWarning("update check failed", error).pipe(
            Effect.as<DesktopUpdateCheckResult>({
              status: "error",
              message: error.cause instanceof Error ? error.cause.message : error.message,
            }),
          ),
      }),
    );
  }).pipe(Effect.withSpan("DesktopUpdates.check"));

  const recoverFailedInstall = Effect.fn("DesktopUpdates.recoverFailedInstall")(function* (
    message: string,
  ): Effect.fn.Return<void> {
    const install = yield* Ref.getAndSet(installRef, Option.none());

    if (Option.isNone(install)) return;
    yield* logError("update install failed", { message });
    yield* Ref.set(desktopState.quitting, false);

    if (install.value.backendWasRunning) yield* backend.restart;
    yield* dialog.showMessageBox({
      type: "warning",
      title: "Update failed",
      message: "The update could not be installed.",
      detail: message,
      buttons: ["OK"],
    });
  });

  // quitAndInstall quits without waiting for layer finalizers, so the server stops here first.
  const install: Effect.Effect<void> = Effect.gen(function* () {
    if (yield* Ref.get(desktopState.quitting)) return;
    const backendWasRunning = (yield* backend.snapshot).desiredRunning;
    yield* Ref.set(installRef, Option.some({ backendWasRunning }));
    yield* Ref.set(desktopState.quitting, true);

    yield* Effect.gen(function* () {
      yield* backend.stop({ timeout: INSTALL_BACKEND_STOP_TIMEOUT });
      yield* updater.quitAndInstall({ isSilent: true, isForceRunAfter: true });
    }).pipe(
      Effect.catchTags({
        ElectronUpdaterQuitAndInstallError: (error) => recoverFailedInstall(error.message),
      }),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : recoverFailedInstall("The update install failed unexpectedly."),
      ),
    );
  }).pipe(Effect.withSpan("DesktopUpdates.install"));

  const promptRestart = (version: string) =>
    dialog
      .showMessageBox({
        type: "info",
        title: "Update ready",
        message: `Version ${version} has been downloaded.`,
        detail: "Restart now to install it, or it will install the next time you quit.",
        buttons: ["Restart", "Later"],
        defaultId: 0,
        cancelId: 1,
      })
      .pipe(Effect.flatMap(({ response }) => (response === 0 ? install : Effect.void)));

  const backgroundCheck = updater.checkForUpdates.pipe(
    Effect.catchTags({
      ElectronUpdaterCheckError: (error) => logWarning("update check failed", error),
    }),
  );

  const configure = Effect.gen(function* () {
    yield* Ref.set(appUpdateYmlConfigRef, yield* readAppUpdateYml);
    const reason = yield* disabledReason;

    if (Option.isSome(reason)) {
      yield* logInfo("automatic updates are off", { reason: reason.value });

      return;
    }

    yield* updater.configure({ autoDownload: true, autoInstallOnAppQuit: true });
    yield* updater.on("update-available", (info) => {
      runSync(
        Ref.set(lastCheckResultRef, Option.some({ status: "available", version: info.version })),
      );
    });
    yield* updater.on("update-not-available", () => {
      runSync(
        Ref.set(
          lastCheckResultRef,
          Option.some({ status: "up-to-date", currentVersion: environment.appVersion }),
        ),
      );
    });
    yield* updater.on("update-downloaded", (info) => {
      runFork(promptRestart(info.version));
    });
    yield* updater.on("error", (error) => {
      runSync(
        Ref.set(lastCheckResultRef, Option.some({ status: "error", message: error.message })),
      );
      runFork(
        Effect.gen(function* () {
          yield* logWarning("updater error", error);
          // An installer that fails after quitAndInstall returned reports it here.
          yield* recoverFailedInstall(error.message);
        }),
      );
    });
    yield* Ref.set(updaterConfiguredRef, true);
    yield* backgroundCheck.pipe(Effect.repeat(Schedule.spaced(CHECK_INTERVAL)), Effect.forkScoped);
  }).pipe(Effect.withSpan("DesktopUpdates.configure"));

  return DesktopUpdates.of({ configure, disabledReason, check, install });
});

export const layer = Layer.effect(DesktopUpdates, make);
