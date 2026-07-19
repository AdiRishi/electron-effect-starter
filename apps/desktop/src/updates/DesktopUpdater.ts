import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import {
  DesktopUpdateChannel,
  type DesktopUpdateState,
  type DesktopUpdateStatus,
} from "@app/contracts";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { UPDATE_STATE_CHANNEL } from "../ipc/channels.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

// Holds the current update state, drives `electron-updater` when packaged, and
// pushes every change to the renderer over UPDATE_STATE_CHANNEL. When the app is
// not packaged there is no feed/signing, so it stays "disabled" and the action
// methods are inert — the renderer's update UI degrades to read-only.

const { logInfo } = makeComponentLogger("desktop-updater");

type DesktopUpdateAction = "check" | "download" | "install";

export class DesktopUpdateActionInProgressError extends Schema.TaggedErrorClass<DesktopUpdateActionInProgressError>()(
  "DesktopUpdateActionInProgressError",
  {
    action: Schema.Literals(["check", "download", "install"]),
    requestedChannel: DesktopUpdateChannel,
  },
) {
  override get message(): string {
    return `Cannot change the desktop update channel to ${this.requestedChannel} while an update ${this.action} action is in progress.`;
  }
}

interface UpdateStatePatch {
  readonly status: DesktopUpdateStatus;
  readonly version?: string | null;
  readonly message?: string | null;
}

function readVersion(info: unknown): string | null {
  if (Predicate.hasProperty("version")(info)) {
    return Predicate.isString(info.version) ? info.version : null;
  }
  return null;
}

function readPercent(progress: unknown): string | null {
  if (Predicate.hasProperty("percent")(progress)) {
    return Predicate.isNumber(progress.percent) ? `${Math.round(progress.percent)}%` : null;
  }
  return null;
}

function describeError(error: unknown): string {
  return Predicate.isError(error) ? error.message : String(error);
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
    readonly setChannel: (
      channel: DesktopUpdateChannel,
    ) => Effect.Effect<DesktopUpdateState, DesktopUpdateActionInProgressError>;
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

  // Only one action drives electron-updater at a time; a renderer spamming
  // check/download/install must not overlap driver calls.
  const actionInFlightRef = yield* Ref.make(Option.none<DesktopUpdateAction>());

  const claimAction = (action: DesktopUpdateAction) =>
    Ref.modify(actionInFlightRef, (current) =>
      Option.isSome(current)
        ? ([false, current] as const)
        : ([true, Option.some<DesktopUpdateAction>(action)] as const),
    );
  const releaseAction = Ref.set(actionInFlightRef, Option.none<DesktopUpdateAction>());

  // Move to a "starting" status, run the driver call, and fold any failure into
  // an error state instead of widening the infallible public method. A request
  // that arrives while another action is in flight is dropped.
  const runAction = (
    action: DesktopUpdateAction,
    start: UpdateStatePatch,
    driver: Effect.Effect<void, { readonly message: string }>,
  ) =>
    Effect.gen(function* () {
      if (!(yield* claimAction(action))) {
        return;
      }
      yield* applyPatch(start).pipe(
        Effect.andThen(driver),
        Effect.catch((error) => applyPatch({ status: "error", message: error.message })),
        Effect.asVoid,
        Effect.ensuring(releaseAction),
      );
    });

  return DesktopUpdater.of({
    configure: enabled
      ? Effect.gen(function* () {
          yield* electronUpdater.setAutoDownload(false);
          yield* electronUpdater.setAutoInstallOnAppQuit(false);
          yield* electronUpdater.setChannel(persisted.updateChannel);
          yield* logInfo("updater configured", {
            channel: persisted.updateChannel,
          });
        }).pipe(Effect.withSpan("desktop.updater.configure"))
      : logInfo("updater disabled (app is not packaged)"),
    getState: Ref.get(stateRef),
    setChannel: (channel) =>
      Effect.gen(function* () {
        // Refuse a channel switch while an action is driving electron-updater:
        // switching mid-download/install would leave the driver and the
        // persisted channel disagreeing about what is being fetched.
        const activeAction = yield* Ref.get(actionInFlightRef);
        if (Option.isSome(activeAction)) {
          return yield* new DesktopUpdateActionInProgressError({
            action: activeAction.value,
            requestedChannel: channel,
          });
        }
        // A settings-write failure here is unexpected; the public method's only
        // declared error is the in-progress guard, so surface it as a defect.
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
      ? runAction(
          "check",
          { status: "checking", message: null },
          electronUpdater.checkForUpdates,
        ).pipe(Effect.withSpan("desktop.updater.check"))
      : Effect.void.pipe(Effect.withSpan("desktop.updater.check")),
    download: enabled
      ? runAction(
          "download",
          { status: "downloading", message: null },
          electronUpdater.downloadUpdate,
        ).pipe(Effect.withSpan("desktop.updater.download"))
      : Effect.void.pipe(Effect.withSpan("desktop.updater.download")),
    install: enabled
      ? Effect.gen(function* () {
          if (!(yield* claimAction("install"))) {
            return;
          }
          yield* electronUpdater.quitAndInstall({ isSilent: false, isForceRunAfter: true }).pipe(
            Effect.catch((error) => applyPatch({ status: "error", message: error.message })),
            Effect.asVoid,
            Effect.ensuring(releaseAction),
          );
        }).pipe(Effect.withSpan("desktop.updater.install"))
      : Effect.void.pipe(Effect.withSpan("desktop.updater.install")),
  });
});

// `Layer.effect` excludes `Scope` from the requirements: the event listeners
// registered in `make` live for the layer's (app's) lifetime.
export const layer = Layer.effect(DesktopUpdater, make);
