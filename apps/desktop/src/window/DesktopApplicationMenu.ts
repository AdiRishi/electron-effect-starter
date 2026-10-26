import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";

export class DesktopApplicationMenu extends Context.Service<
  DesktopApplicationMenu,
  { readonly configure: Effect.Effect<void> }
>()("@app/desktop/window/DesktopApplicationMenu") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const menu = yield* ElectronMenu.ElectronMenu;
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());

  const checkForUpdates: Electron.MenuItemConstructorOptions = {
    label: "Check for Updates…",
    click: () => {
      runFork(updates.checkFromMenu);
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
