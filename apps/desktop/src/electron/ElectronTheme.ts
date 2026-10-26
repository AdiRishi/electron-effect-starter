import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import * as Electron from "electron";

export class ElectronTheme extends Context.Service<
  ElectronTheme,
  {
    readonly shouldUseDarkColors: Effect.Effect<boolean>;
    readonly onUpdated: (listener: () => void) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@app/desktop/electron/ElectronTheme") {}

const make = ElectronTheme.of({
  shouldUseDarkColors: Effect.sync(() => Electron.nativeTheme.shouldUseDarkColors),
  onUpdated: Effect.fn("ElectronTheme.onUpdated")(function (listener: () => void) {
    return Effect.acquireRelease(
      Effect.sync(() => Electron.nativeTheme.on("updated", listener)),
      () => Effect.sync(() => Electron.nativeTheme.removeListener("updated", listener)),
    ).pipe(Effect.asVoid);
  }),
});

export const layer = Layer.succeed(ElectronTheme, make);
