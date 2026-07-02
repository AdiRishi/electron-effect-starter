import {
  type DesktopUpdateChannel,
  type DesktopUpdateState,
  type DesktopUpdateStatus,
} from "@app/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { UPDATE_STATE_CHANNEL } from "../ipc/channels.ts";

// Holds the current update state, drives `electron-updater` when packaged, and
// pushes every change to the renderer over UPDATE_STATE_CHANNEL. When the app is
// not packaged there is no feed/signing, so it stays "disabled" and the action
// methods are inert — the renderer's update UI degrades to read-only.

const { logInfo } = makeComponentLogger("desktop-updater");

interface UpdateStatePatch {
  readonly status: DesktopUpdateStatus;
  readonly version?: string | null;
  readonly message?: string | null;
}

function readVersion(info: unknown): string | null {
  if (typeof info === "object" && info !== null && "version" in info) {
    const value = (info as { version?: unknown }).version;
    return typeof value === "string" ? value : null;
  }
  return null;
}

function readPercent(progress: unknown): string | null {
  if (typeof progress === "object" && progress !== null && "percent" in progress) {
    const value = (progress as { percent?: unknown }).percent;
    return typeof value === "number" ? `${Math.round(value)}%` : null;
  }
  return null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Each electron-updater event maps to a partial state update. `undefined`
// fields on the patch leave the current value in place.
const UPDATER_EVENTS: ReadonlyArray<
  readonly [string, (...args: ReadonlyArray<unknown>) => UpdateStatePatch]
> = [
  ["checking-for-update", () => ({ status: "checking", message: null })],
  ["update-available", (info) => ({ status: "available", version: readVersion(info) })],
  ["update-not-available", () => ({ status: "up-to-date", version: null })],
  ["download-progress", (progress) => ({ status: "downloading", message: readPercent(progress) })],
  ["update-downloaded", (info) => ({ status: "downloaded", version: readVersion(info) })],
  ["error", (error) => ({ status: "error", message: describeError(error) })],
];

export class DesktopUpdater extends Context.Service<
  DesktopUpdater,
  {
    readonly configure: Effect.Effect<void>;
    readonly getState: Effect.Effect<DesktopUpdateState>;
    readonly setChannel: (channel: DesktopUpdateChannel) => Effect.Effect<DesktopUpdateState>;
    readonly check: Effect.Effect<void>;
    readonly download: Effect.Effect<void>;
    readonly install: Effect.Effect<void>;
  }
>()("@app/desktop/updates/DesktopUpdater") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const electronUpdater = yield* ElectronUpdater.ElectronUpdater;

  // Not packaged → inert: no release feed and no code signing exist in dev.
  const enabled = environment.isPackaged;
  const initialStatus: DesktopUpdateStatus = enabled ? "idle" : "disabled";
  const persisted = yield* settings.get;
  const stateRef = yield* Ref.make<DesktopUpdateState>({
    status: initialStatus,
    channel: persisted.updateChannel,
    version: null,
    message: null,
  });

  // Updater events fire from raw electron callbacks; run the state effect
  // against the captured context so pushes reach the renderer.
  const context = yield* Effect.context<ElectronWindow.ElectronWindow>();
  const runFork = Effect.runForkWith(context);

  const pushState = (state: DesktopUpdateState) =>
    electronWindow.sendAll(UPDATE_STATE_CHANNEL, state);

  const applyPatch = (patch: UpdateStatePatch) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(stateRef);
      const next: DesktopUpdateState = {
        status: patch.status,
        channel: current.channel,
        version: patch.version === undefined ? current.version : patch.version,
        message: patch.message === undefined ? current.message : patch.message,
      };
      yield* Ref.set(stateRef, next);
      yield* pushState(next);
      return next;
    });

  // Translate updater events into pushed state changes for the app's lifetime
  // (Layer.scoped ties the listeners to the layer scope).
  if (enabled) {
    for (const [eventName, toPatch] of UPDATER_EVENTS) {
      yield* electronUpdater.on(eventName, (...args: ReadonlyArray<unknown>) => {
        runFork(applyPatch(toPatch(...args)));
      });
    }
  }

  // Move to a "starting" status, run the driver call, and fold any failure into
  // an error state instead of widening the infallible public method.
  const runAction = (
    start: UpdateStatePatch,
    action: Effect.Effect<void, { readonly message: string }>,
  ) =>
    applyPatch(start).pipe(
      Effect.andThen(action),
      Effect.catch((error) => applyPatch({ status: "error", message: error.message })),
      Effect.asVoid,
    );

  return DesktopUpdater.of({
    configure: enabled
      ? Effect.gen(function* () {
          yield* electronUpdater.setAutoDownload(false);
          yield* electronUpdater.setChannel(persisted.updateChannel);
          // ── DESIGN SEAM (updates) ── point the updater at your release feed:
          //   yield* electronUpdater.setFeedURL({
          //     provider: "generic",
          //     url: "https://updates.example.com/latest",
          //   });
          yield* logInfo("updater configured", {
            channel: persisted.updateChannel,
          });
        }).pipe(Effect.withSpan("desktop.updater.configure"))
      : logInfo("updater disabled (app is not packaged)"),
    getState: Ref.get(stateRef),
    setChannel: (channel) =>
      Effect.gen(function* () {
        // A settings-write failure here is unexpected; the public method is
        // declared infallible, so surface it as a defect.
        yield* settings.setUpdateChannel(channel).pipe(Effect.orDie);
        if (enabled) {
          yield* electronUpdater.setChannel(channel);
        }
        const current = yield* Ref.get(stateRef);
        const next: DesktopUpdateState = { ...current, channel };
        yield* Ref.set(stateRef, next);
        yield* pushState(next);
        return next;
      }).pipe(
        Effect.withSpan("desktop.updater.setChannel", {
          attributes: { channel },
        }),
      ),
    check: enabled
      ? runAction({ status: "checking", message: null }, electronUpdater.checkForUpdates).pipe(
          Effect.withSpan("desktop.updater.check"),
        )
      : Effect.void.pipe(Effect.withSpan("desktop.updater.check")),
    download: enabled
      ? runAction({ status: "downloading", message: null }, electronUpdater.downloadUpdate).pipe(
          Effect.withSpan("desktop.updater.download"),
        )
      : Effect.void.pipe(Effect.withSpan("desktop.updater.download")),
    install: enabled
      ? electronUpdater.quitAndInstall({ isSilent: false, isForceRunAfter: true }).pipe(
          Effect.catch((error) => applyPatch({ status: "error", message: error.message })),
          Effect.asVoid,
          Effect.withSpan("desktop.updater.install"),
        )
      : Effect.void.pipe(Effect.withSpan("desktop.updater.install")),
  });
});

// `Layer.effect` excludes `Scope` from the requirements: the event listeners
// registered in `make` live for the layer's (app's) lifetime.
export const layer = Layer.effect(DesktopUpdater, make);
