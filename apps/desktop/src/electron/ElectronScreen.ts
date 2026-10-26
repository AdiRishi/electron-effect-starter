import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

export class ElectronScreen extends Context.Service<
  ElectronScreen,
  {
    /** The bounds of every connected display. */
    readonly displayBounds: Effect.Effect<ReadonlyArray<Electron.Rectangle>>;
  }
>()("@app/desktop/electron/ElectronScreen") {}

const make = ElectronScreen.of({
  displayBounds: Effect.sync(() =>
    Electron.screen.getAllDisplays().map((display) => display.bounds),
  ),
});

export const layer = Layer.succeed(ElectronScreen, make);
