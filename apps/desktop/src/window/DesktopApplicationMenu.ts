import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopLogger from "../app/DesktopLogger.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

export class DesktopApplicationMenu extends Context.Service<
  DesktopApplicationMenu,
  { readonly configure: Effect.Effect<void> }
>()("@app/desktop/window/DesktopApplicationMenu") {}

const { logInfo } = DesktopLogger.forComponent("desktop-menu");

const checkForUpdatesFromMenu = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const result = yield* updates.check;

  if (result.status === "up-to-date") {
    yield* electronDialog.showMessageBox({
      type: "info",
      title: "You're up to date!",
      message: `${environment.displayName} ${result.currentVersion} is currently the newest version available.`,
      buttons: ["OK"],
    });
  } else if (result.status === "error") {
    yield* electronDialog.showMessageBox({
      type: "warning",
      title: "Update check failed",
      message: "Could not check for updates.",
      detail: result.message,
      buttons: ["OK"],
    });
  }
}).pipe(Effect.withSpan("DesktopApplicationMenu.checkForUpdates"));

/** Reports the outcome of a check the user asked for; an available update reports itself once downloaded. */
export const handleCheckForUpdatesMenuClick = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const disabledReason = yield* updates.disabledReason;

  if (Option.isSome(disabledReason)) {
    yield* logInfo("manual update check requested, but updates are disabled", {
      disabledReason: disabledReason.value,
    });
    yield* electronDialog.showMessageBox({
      type: "info",
      title: "Updates unavailable",
      message: "Automatic updates are not available right now.",
      detail: disabledReason.value,
      buttons: ["OK"],
    });

    return;
  }

  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.activate;
  yield* checkForUpdatesFromMenu;
}).pipe(Effect.withSpan("DesktopApplicationMenu.handleCheckForUpdatesClick"));

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const menu = yield* ElectronMenu.ElectronMenu;

  const runFork = Effect.runForkWith(
    yield* Effect.context<
      | DesktopEnvironment.DesktopEnvironment
      | DesktopUpdates.DesktopUpdates
      | DesktopWindow.DesktopWindow
      | ElectronDialog.ElectronDialog
    >(),
  );

  const checkForUpdates: Electron.MenuItemConstructorOptions = {
    label: "Check for Updates…",
    click: () => {
      runFork(handleCheckForUpdatesMenuClick);
    },
  };

  const template: ReadonlyArray<Electron.MenuItemConstructorOptions> = [
    ...(environment.platform === "darwin"
      ? [
          {
            role: "appMenu" as const,
            submenu: [
              { role: "about" as const },
              checkForUpdates,
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : [{ role: "fileMenu" as const }]),
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    ...(environment.platform === "darwin"
      ? []
      : [{ role: "help" as const, submenu: [checkForUpdates] }]),
  ];

  return DesktopApplicationMenu.of({ configure: menu.setApplicationMenu(template) });
});

export const layer = Layer.effect(DesktopApplicationMenu, make);
