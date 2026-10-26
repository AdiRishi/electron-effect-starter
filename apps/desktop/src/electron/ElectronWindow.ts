import * as HostProcess from "@app/shared/HostProcess";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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

export class ElectronWindowOperationError extends Schema.TaggedError<ElectronWindowOperationError>()(
  "ElectronWindowOperationError",
  {
    operation: Schema.Literals(["destroy-window"]),
    windowId: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron window operation "${this.operation}" failed for window ${this.windowId}.`;
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
    /** Destroys every window, continuing past failures; fails with the first one. */
    readonly destroyAll: Effect.Effect<void>;
    readonly syncAllAppearance: (
      sync: (window: Electron.BrowserWindow) => Effect.Effect<void>,
    ) => Effect.Effect<void>;
  }
>()("@app/desktop/electron/ElectronWindow") {}

/** The process-wide window list; Electron's BrowserWindow in the app, a fake in tests. */
export interface ElectronWindowList {
  readonly getAllWindows: () => ReadonlyArray<Electron.BrowserWindow>;
}

export const make = Effect.fn("ElectronWindow.make")(function* (windowList: ElectronWindowList) {
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
    destroyAll: Effect.gen(function* () {
      let firstFailure: Cause.Cause<never> | undefined;

      for (const window of windowList.getAllWindows()) {
        const exit = yield* Effect.exit(
          Effect.try({
            try: () => window.destroy(),
            catch: (cause) =>
              new ElectronWindowOperationError({
                operation: "destroy-window",
                windowId: window.id,
                cause,
              }),
          }).pipe(Effect.orDie),
        );

        if (Exit.isFailure(exit)) firstFailure ??= exit.cause;
      }

      if (firstFailure !== undefined) return yield* Effect.failCause(firstFailure);
    }).pipe(Effect.withSpan("ElectronWindow.destroyAll")),
    syncAllAppearance: Effect.fn("ElectronWindow.syncAllAppearance")(function* (
      sync: (window: Electron.BrowserWindow) => Effect.Effect<void>,
    ) {
      for (const window of windowList.getAllWindows()) {
        if (!window.isDestroyed()) yield* sync(window);
      }
    }),
  });
});

export const layer = Layer.effect(ElectronWindow, make(Electron.BrowserWindow));
