import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopLogger from "../app/DesktopLogger.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";

const CHECK_INTERVAL = "4 hours";

const { logInfo, logWarning } = DesktopLogger.forComponent("desktop-updates");

/**
 * Checks for updates in packaged builds, downloads them in the background, and offers a restart
 * once one is ready; an update not installed then is applied on the next quit.
 */
export class DesktopUpdates extends Context.Service<
  DesktopUpdates,
  {
    readonly configure: Effect.Effect<void, never, Scope.Scope>;
    readonly checkFromMenu: Effect.Effect<void>;
  }
>()("@app/desktop/updates/DesktopUpdates") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const updater = yield* ElectronUpdater.ElectronUpdater;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const enabled = environment.isPackaged && !environment.disableAutoUpdate;
  // Only a check the user asked for reports "up to date" or a failure in a dialog.
  const userInitiatedCheck = yield* Ref.make(false);

  const check = updater.checkForUpdates.pipe(
    Effect.catchTags({
      ElectronUpdaterCheckError: (error) => logWarning("update check failed", error),
    }),
  );

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
      .pipe(
        Effect.flatMap(({ response }) => (response === 0 ? updater.quitAndInstall : Effect.void)),
      );

  const configure = Effect.gen(function* () {
    if (!enabled) {
      yield* logInfo("automatic updates are off", { packaged: environment.isPackaged });
      return;
    }
    yield* updater.configure({ autoDownload: true, autoInstallOnAppQuit: true });
    yield* updater.on("update-downloaded", (info) => {
      runFork(promptRestart(info.version));
    });
    yield* updater.on("update-not-available", () => {
      runFork(
        Ref.getAndSet(userInitiatedCheck, false).pipe(
          Effect.flatMap((asked) =>
            asked
              ? dialog.showMessageBox({
                  type: "info",
                  title: "No updates",
                  message: `You're on the latest version (${environment.appVersion}).`,
                })
              : Effect.void,
          ),
        ),
      );
    });
    yield* updater.on("error", (error) => {
      runFork(logWarning("updater error", error));
    });
    yield* check.pipe(Effect.repeat(Schedule.spaced(CHECK_INTERVAL)), Effect.forkScoped);
  }).pipe(Effect.withSpan("DesktopUpdates.configure"));

  const checkFromMenu = enabled
    ? Ref.set(userInitiatedCheck, true).pipe(Effect.andThen(check))
    : dialog
        .showMessageBox({
          type: "info",
          title: "Updates",
          message: "Updates are checked only in packaged builds.",
        })
        .pipe(Effect.asVoid);

  return DesktopUpdates.of({ configure, checkFromMenu });
});

export const layer = Layer.effect(DesktopUpdates, make);
