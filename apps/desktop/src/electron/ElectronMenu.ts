import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

export interface ElectronMenuTemplateInput {
  readonly window: Electron.BrowserWindow;
  readonly template: ReadonlyArray<Electron.MenuItemConstructorOptions>;
  readonly frame?: Electron.WebFrameMain;
}

export class ElectronMenu extends Context.Service<
  ElectronMenu,
  {
    readonly setApplicationMenu: (
      template: ReadonlyArray<Electron.MenuItemConstructorOptions>,
    ) => Effect.Effect<void>;
    readonly popupTemplate: (input: ElectronMenuTemplateInput) => Effect.Effect<void>;
  }
>()("@app/desktop/electron/ElectronMenu") {}

const make = ElectronMenu.of({
  setApplicationMenu: Effect.fn("ElectronMenu.setApplicationMenu")(function (
    template: ReadonlyArray<Electron.MenuItemConstructorOptions>,
  ) {
    return Effect.sync(() =>
      Electron.Menu.setApplicationMenu(Electron.Menu.buildFromTemplate([...template])),
    );
  }),
  popupTemplate: Effect.fn("ElectronMenu.popupTemplate")(function (
    input: ElectronMenuTemplateInput,
  ) {
    return input.template.length === 0
      ? Effect.void
      : Effect.sync(() =>
          Electron.Menu.buildFromTemplate([...input.template]).popup({
            window: input.window,
            ...(input.frame ? { frame: input.frame } : {}),
          }),
        );
  }),
});

export const layer = Layer.succeed(ElectronMenu, make);
