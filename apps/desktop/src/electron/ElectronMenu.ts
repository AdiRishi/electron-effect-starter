import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

export class ElectronMenu extends Context.Service<
  ElectronMenu,
  {
    readonly setApplicationMenu: (
      template: ReadonlyArray<Electron.MenuItemConstructorOptions>,
    ) => Effect.Effect<void>;
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
});

export const layer = Layer.succeed(ElectronMenu, make);
