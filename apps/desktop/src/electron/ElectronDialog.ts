import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

export class ElectronDialog extends Context.Service<
  ElectronDialog,
  {
    readonly showErrorBox: (title: string, content: string) => Effect.Effect<void>;
    readonly showMessageBox: (
      options: Electron.MessageBoxOptions,
    ) => Effect.Effect<Electron.MessageBoxReturnValue>;
  }
>()("@app/desktop/electron/ElectronDialog") {}

const make = ElectronDialog.of({
  showErrorBox: Effect.fn("ElectronDialog.showErrorBox")(function (title: string, content: string) {
    return Effect.sync(() => Electron.dialog.showErrorBox(title, content));
  }),
  showMessageBox: Effect.fn("ElectronDialog.showMessageBox")(function (
    options: Electron.MessageBoxOptions,
  ) {
    return Effect.promise(() => Electron.dialog.showMessageBox(options));
  }),
});

export const layer = Layer.succeed(ElectronDialog, make);
