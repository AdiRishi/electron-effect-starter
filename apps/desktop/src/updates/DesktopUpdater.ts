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
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { UPDATE_STATE_CHANNEL } from "../ipc/channels.ts";

// Holds the current update state and pushes changes to the renderer. This is
// deliberately a thin stub: when the app isn't packaged there is no real update
// infrastructure, so state stays `"disabled"` and the action methods are no-ops.
// Wire `ElectronUpdater` + a feed URL here to make it real.

const { logInfo } = makeComponentLogger("desktop-updater");

function makeState(
  status: DesktopUpdateStatus,
  channel: DesktopUpdateChannel,
  overrides?: { version?: string | null; message?: string | null },
): DesktopUpdateState {
  return {
    status,
    channel,
    version: overrides?.version ?? null,
    message: overrides?.message ?? null,
  };
}

export class DesktopUpdater extends Context.Service<
  DesktopUpdater,
  {
    readonly configure: Effect.Effect<void>;
    readonly getState: Effect.Effect<DesktopUpdateState>;
    readonly setChannel: (
      channel: DesktopUpdateChannel,
    ) => Effect.Effect<DesktopUpdateState>;
    readonly check: Effect.Effect<void>;
    readonly download: Effect.Effect<void>;
    readonly install: Effect.Effect<void>;
  }
>()("@app/desktop/updates/DesktopUpdater") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const electronWindow = yield* ElectronWindow.ElectronWindow;

  // Not packaged → updater is inert. A packaged build would flip this to "idle"
  // and drive the real electron-updater flow.
  const initialStatus: DesktopUpdateStatus = environment.isPackaged
    ? "idle"
    : "disabled";
  const persisted = yield* settings.get;
  const stateRef = yield* Ref.make(
    makeState(initialStatus, persisted.updateChannel),
  );

  const pushState = (state: DesktopUpdateState) =>
    electronWindow.sendAll(UPDATE_STATE_CHANNEL, state);

  const setState = (state: DesktopUpdateState) =>
    Ref.set(stateRef, state).pipe(Effect.andThen(pushState(state)));

  return DesktopUpdater.of({
    configure: logInfo("updater configured", { status: initialStatus }),
    getState: Ref.get(stateRef),
    setChannel: (channel) =>
      Effect.gen(function* () {
        // A settings-write failure here is unexpected; the updater's public
        // method is declared infallible, so surface it as a defect.
        yield* settings.setUpdateChannel(channel).pipe(Effect.orDie);
        const current = yield* Ref.get(stateRef);
        const next = { ...current, channel };
        yield* setState(next);
        return next;
      }).pipe(
        Effect.withSpan("desktop.updater.setChannel", {
          attributes: { channel },
        }),
      ),
    check: Effect.void.pipe(Effect.withSpan("desktop.updater.check")),
    download: Effect.void.pipe(Effect.withSpan("desktop.updater.download")),
    install: Effect.void.pipe(Effect.withSpan("desktop.updater.install")),
  });
});

export const layer = Layer.effect(DesktopUpdater, make);
