// @effect-diagnostics effectFnOpportunity:off -- Test fakes are inline stubs, not traced functions.
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import type * as Electron from "electron";

import * as DesktopEnvironment from "../../src/app/DesktopEnvironment.ts";
import * as DesktopState from "../../src/app/DesktopState.ts";
import * as DesktopBackend from "../../src/backend/DesktopBackend.ts";
import * as ElectronDialog from "../../src/electron/ElectronDialog.ts";
import * as ElectronUpdater from "../../src/electron/ElectronUpdater.ts";
import * as DesktopUpdates from "../../src/updates/DesktopUpdates.ts";
import * as DesktopWindow from "../../src/window/DesktopWindow.ts";
import { testEnvironment } from "./environment.ts";

/** What electron-updater passes its listeners: update info, or the error. */
export type UpdaterEventPayload = { readonly version: string } | Error;

export interface UpdatesHarnessOptions {
  readonly environment?: Partial<DesktopEnvironment.DesktopEnvironment["Service"]>;
  readonly appUpdateYml?: string | undefined;
  readonly packageType?: string | undefined;
  readonly checkForUpdates?: (
    emit: (eventName: string, payload: UpdaterEventPayload) => void,
  ) => Effect.Effect<void, ElectronUpdater.ElectronUpdaterCheckError>;
  readonly quitAndInstall?: Effect.Effect<void, ElectronUpdater.ElectronUpdaterQuitAndInstallError>;
  readonly backendDesiredRunning?: boolean;
  readonly dialogResponse?: number;
}

const notFound = (path: string) =>
  PlatformError.systemError({
    module: "FileSystem",
    method: "readFileString",
    // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- systemError takes the reason tag as input.
    _tag: "NotFound",
    pathOrDescriptor: path,
  });

/** The updater, dialogs and the server are the external seams; DesktopUpdates itself is real. */
export function makeUpdatesHarness(options: UpdatesHarnessOptions = {}) {
  const listeners = new Map<string, Set<(payload: never) => void>>();
  const installSteps: string[] = [];
  const dialogs: Electron.MessageBoxOptions[] = [];
  const quitAndInstallOptions: Array<{ isSilent: boolean; isForceRunAfter: boolean }> = [];
  let checkCount = 0;
  let backendDesiredRunning = options.backendDesiredRunning ?? true;

  const emit = (eventName: string, payload: UpdaterEventPayload) => {
    for (const listener of listeners.get(eventName) ?? []) {
      // SAFETY: each test emits the payload electron-updater sends for that event.
      (listener as (payload: UpdaterEventPayload) => void)(payload);
    }
  };

  const environment = testEnvironment({
    isPackaged: true,
    platform: "darwin",
    appVersion: "1.2.3",
    ...options.environment,
  });

  const appUpdateYml =
    "appUpdateYml" in options
      ? options.appUpdateYml
      : "provider: github\nowner: example\nrepo: app\n";

  const layerUpdater = Layer.succeed(
    ElectronUpdater.ElectronUpdater,
    ElectronUpdater.ElectronUpdater.of({
      configure: () => Effect.void,
      checkForUpdates: Effect.suspend(() => {
        checkCount += 1;

        return options.checkForUpdates?.(emit) ?? Effect.void;
      }),
      quitAndInstall: (input) =>
        Effect.sync(() => {
          installSteps.push("quitAndInstall");
          quitAndInstallOptions.push({ ...input });
        }).pipe(Effect.andThen(options.quitAndInstall ?? Effect.void)),
      on: (eventName, listener) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const eventListeners = listeners.get(eventName) ?? new Set();
            eventListeners.add(listener);
            listeners.set(eventName, eventListeners);
          }),
          () => Effect.sync(() => listeners.get(eventName)?.delete(listener)),
        ).pipe(Effect.asVoid),
    }),
  );

  const layerBackend = Layer.succeed(
    DesktopBackend.DesktopBackend,
    DesktopBackend.DesktopBackend.of({
      start: () => Effect.die("unexpected first start"),
      restart: Effect.sync(() => {
        backendDesiredRunning = true;
        installSteps.push("startBackend");
      }),
      stop: () =>
        Effect.sync(() => {
          backendDesiredRunning = false;
          installSteps.push("stopBackend");
        }),
      snapshot: Effect.sync(() => ({
        desiredRunning: backendDesiredRunning,
        ready: backendDesiredRunning,
        activePid: Option.none(),
        restartAttempt: 0,
        restartScheduled: false,
      })),
      bootstrapToken: "token",
      rendererBootstrap: Effect.succeed(null),
    }),
  );

  const layerDialog = Layer.succeed(
    ElectronDialog.ElectronDialog,
    ElectronDialog.ElectronDialog.of({
      showErrorBox: () => Effect.void,
      showMessageBox: (messageBox) =>
        Effect.sync(() => {
          dialogs.push(messageBox);

          return { response: options.dialogResponse ?? 1, checkboxChecked: false };
        }),
    }),
  );

  const layerFileSystem = FileSystem.layerNoop({
    readFileString: (path) => {
      if (path === environment.appUpdateYmlPath && appUpdateYml !== undefined) {
        return Effect.succeed(appUpdateYml);
      }

      if (path === `${environment.resourcesPath}/package-type` && options.packageType) {
        return Effect.succeed(options.packageType);
      }

      return Effect.fail(notFound(path));
    },
  });

  const layerWindow = Layer.succeed(
    DesktopWindow.DesktopWindow,
    DesktopWindow.DesktopWindow.of({
      activate: Effect.void,
      handleBackendReady: () => Effect.void,
      handleBackendNotReady: Effect.void,
    }),
  );

  const layer = DesktopUpdates.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
        DesktopState.layer,
        layerBackend,
        layerUpdater,
        layerDialog,
        layerFileSystem,
        layerWindow,
        NodePath.layerPosix,
      ),
    ),
  );

  return {
    layer,
    emit,
    installSteps,
    dialogs,
    quitAndInstallOptions,
    checkCount: () => checkCount,
  };
}
