import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { autoUpdater } from "electron-updater";

/** The updater events this shell listens to, with the arguments electron-updater passes. */
interface ElectronUpdaterEvents {
  readonly "update-available": readonly [info: { readonly version: string }];
  readonly "update-not-available": readonly [info: { readonly version: string }];
  readonly "update-downloaded": readonly [info: { readonly version: string }];
  readonly error: readonly [error: Error];
}

export class ElectronUpdaterCheckError extends Schema.TaggedError<ElectronUpdaterCheckError>()(
  "ElectronUpdaterCheckError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to check for updates.";
  }
}

export class ElectronUpdaterQuitAndInstallError extends Schema.TaggedError<ElectronUpdaterQuitAndInstallError>()(
  "ElectronUpdaterQuitAndInstallError",
  { isSilent: Schema.Boolean, isForceRunAfter: Schema.Boolean, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to quit and install the update (silent: ${this.isSilent}, force run after: ${this.isForceRunAfter}).`;
  }
}

export class ElectronUpdater extends Context.Service<
  ElectronUpdater,
  {
    readonly configure: (options: {
      readonly autoDownload: boolean;
      readonly autoInstallOnAppQuit: boolean;
    }) => Effect.Effect<void>;
    readonly checkForUpdates: Effect.Effect<void, ElectronUpdaterCheckError>;
    readonly quitAndInstall: (options: {
      readonly isSilent: boolean;
      readonly isForceRunAfter: boolean;
    }) => Effect.Effect<void, ElectronUpdaterQuitAndInstallError>;
    readonly on: <K extends keyof ElectronUpdaterEvents>(
      eventName: K,
      listener: (...args: ElectronUpdaterEvents[K]) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@app/desktop/electron/ElectronUpdater") {}

const make = ElectronUpdater.of({
  configure: Effect.fn("ElectronUpdater.configure")(function (options: {
    readonly autoDownload: boolean;
    readonly autoInstallOnAppQuit: boolean;
  }) {
    return Effect.sync(() => {
      autoUpdater.autoDownload = options.autoDownload;
      autoUpdater.autoInstallOnAppQuit = options.autoInstallOnAppQuit;
    });
  }),
  checkForUpdates: Effect.tryPromise({
    try: () => autoUpdater.checkForUpdates(),
    catch: (cause) => new ElectronUpdaterCheckError({ cause }),
  }).pipe(Effect.asVoid),
  quitAndInstall: Effect.fn("ElectronUpdater.quitAndInstall")(function ({
    isSilent,
    isForceRunAfter,
  }: {
    readonly isSilent: boolean;
    readonly isForceRunAfter: boolean;
  }) {
    return Effect.try({
      try: () => autoUpdater.quitAndInstall(isSilent, isForceRunAfter),
      catch: (cause) =>
        new ElectronUpdaterQuitAndInstallError({ isSilent, isForceRunAfter, cause }),
    });
  }),
  on: Effect.fn("ElectronUpdater.on")(function <K extends keyof ElectronUpdaterEvents>(
    eventName: K,
    listener: (...args: ElectronUpdaterEvents[K]) => void,
  ) {
    // AppUpdater is an EventEmitter; the event map above keeps listener arguments typed.
    const emitter: NodeJS.EventEmitter = autoUpdater;

    return Effect.acquireRelease(
      Effect.sync(() => emitter.on(eventName, listener)),
      () => Effect.sync(() => emitter.removeListener(eventName, listener)),
    ).pipe(Effect.asVoid);
  }),
});

export const layer = Layer.succeed(ElectronUpdater, make);
