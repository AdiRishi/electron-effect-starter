import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import * as Electron from "electron";

export interface ElectronAppMetadata {
  readonly appVersion: string;
  readonly appPath: string;
  readonly isPackaged: boolean;
  readonly userDataPath: string;
}

/** The app events this shell listens to, with the arguments Electron passes. */
export interface ElectronAppEvents {
  readonly "before-quit": readonly [event: Electron.Event];
  readonly activate: readonly [];
  readonly "window-all-closed": readonly [];
  readonly "second-instance": readonly [
    event: Electron.Event,
    argv: ReadonlyArray<string>,
    workingDirectory: string,
  ];
}

export class ElectronAppWhenReadyError extends Schema.TaggedError<ElectronAppWhenReadyError>()(
  "ElectronAppWhenReadyError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to wait for the Electron app to become ready.";
  }
}

export class ElectronApp extends Context.Service<
  ElectronApp,
  {
    readonly metadata: Effect.Effect<ElectronAppMetadata>;
    readonly whenReady: Effect.Effect<void, ElectronAppWhenReadyError>;
    readonly requestSingleInstanceLock: Effect.Effect<boolean>;
    readonly quit: Effect.Effect<void>;
    readonly exit: (code: number) => Effect.Effect<void>;
    readonly on: <K extends keyof ElectronAppEvents>(
      eventName: K,
      listener: (...args: ElectronAppEvents[K]) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly onBeforeQuitForUpdate: (
      listener: () => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@app/desktop/electron/ElectronApp") {}

const make = ElectronApp.of({
  metadata: Effect.sync(() => ({
    appVersion: Electron.app.getVersion(),
    appPath: Electron.app.getAppPath(),
    isPackaged: Electron.app.isPackaged,
    userDataPath: Electron.app.getPath("userData"),
  })),
  whenReady: Effect.tryPromise({
    try: () => Electron.app.whenReady(),
    catch: (cause) => new ElectronAppWhenReadyError({ cause }),
  }),
  requestSingleInstanceLock: Effect.sync(() => Electron.app.requestSingleInstanceLock()),
  quit: Effect.sync(() => Electron.app.quit()),
  exit: Effect.fn("ElectronApp.exit")(function (code: number) {
    return Effect.sync(() => Electron.app.exit(code));
  }),
  on: Effect.fn("ElectronApp.on")(function <K extends keyof ElectronAppEvents>(
    eventName: K,
    listener: (...args: ElectronAppEvents[K]) => void,
  ) {
    // App is an EventEmitter; the event map above keeps listener arguments typed.
    const emitter: NodeJS.EventEmitter = Electron.app;

    return Effect.acquireRelease(
      Effect.sync(() => emitter.on(eventName, listener)),
      () => Effect.sync(() => emitter.removeListener(eventName, listener)),
    ).pipe(Effect.asVoid);
  }),
  onBeforeQuitForUpdate: Effect.fn("ElectronApp.onBeforeQuitForUpdate")(function (
    listener: () => void,
  ) {
    return Effect.acquireRelease(
      Effect.sync(() => Electron.autoUpdater.on("before-quit-for-update", listener)),
      () =>
        Effect.sync(() => Electron.autoUpdater.removeListener("before-quit-for-update", listener)),
    ).pipe(Effect.asVoid);
  }),
});

export const layer = Layer.succeed(ElectronApp, make);
