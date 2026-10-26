import * as HostProcess from "@app/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

export class ElectronWindowCreateError extends Schema.TaggedError<ElectronWindowCreateError>()(
  "ElectronWindowCreateError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to create an Electron BrowserWindow.";
  }
}

export class ElectronWindow extends Context.Service<
  ElectronWindow,
  {
    readonly create: (
      options: Electron.BrowserWindowConstructorOptions,
    ) => Effect.Effect<Electron.BrowserWindow, ElectronWindowCreateError>;
    readonly main: Effect.Effect<Option.Option<Electron.BrowserWindow>>;
    readonly setMain: (window: Electron.BrowserWindow) => Effect.Effect<void>;
    readonly clearMain: (window: Electron.BrowserWindow) => Effect.Effect<void>;
    readonly reveal: (window: Electron.BrowserWindow) => Effect.Effect<void>;
    readonly destroyAll: Effect.Effect<void>;
  }
>()("@app/desktop/electron/ElectronWindow") {}

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const mainWindowRef = yield* Ref.make(Option.none<Electron.BrowserWindow>());

  const main = Ref.get(mainWindowRef).pipe(
    Effect.map(Option.filter((window) => !window.isDestroyed())),
  );

  return ElectronWindow.of({
    create: Effect.fn("ElectronWindow.create")(function (
      options: Electron.BrowserWindowConstructorOptions,
    ) {
      return Effect.try({
        try: () => new Electron.BrowserWindow(options),
        catch: (cause) => new ElectronWindowCreateError({ cause }),
      });
    }),
    main,
    setMain: Effect.fn("ElectronWindow.setMain")(function (window: Electron.BrowserWindow) {
      return Ref.set(mainWindowRef, Option.some(window));
    }),
    clearMain: Effect.fn("ElectronWindow.clearMain")(function (window: Electron.BrowserWindow) {
      return Ref.update(mainWindowRef, (current) =>
        Option.isSome(current) && current.value === window ? Option.none() : current,
      );
    }),
    reveal: Effect.fn("ElectronWindow.reveal")(function (window: Electron.BrowserWindow) {
      return Effect.sync(() => {
        if (window.isDestroyed()) return;
        if (window.isMinimized()) window.restore();
        if (!window.isVisible()) window.show();
        if (platform === "darwin") Electron.app.focus({ steal: true });
        window.focus();
      });
    }),
    destroyAll: Effect.sync(() => {
      for (const window of Electron.BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.destroy();
      }
    }),
  });
});

export const layer = Layer.effect(ElectronWindow, make);
