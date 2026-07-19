import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import * as DesktopEnvironment from "../../src/app/DesktopEnvironment.ts";
import * as ElectronUpdater from "../../src/electron/ElectronUpdater.ts";
import * as ElectronWindow from "../../src/electron/ElectronWindow.ts";
import { UPDATE_STATE_CHANNEL } from "../../src/ipc/channels.ts";
import * as DesktopAppSettings from "../../src/settings/DesktopAppSettings.ts";
import * as DesktopUpdater from "../../src/updates/DesktopUpdater.ts";

// This is the payoff of the two-tier split: DesktopUpdater depends only on the
// Electron* wrapper interfaces, so a test provides fake wrappers in place of
// real Electron and asserts on the logic — no window, no autoUpdater.

interface Push {
  readonly channel: string;
  readonly args: ReadonlyArray<unknown>;
}

// A recording fake for the ElectronWindow wrapper. Only `sendAll` matters here;
// the rest are inert stubs that satisfy the interface.
const fakeElectronWindowLayer = (pushes: Array<Push>) =>
  Layer.succeed(
    ElectronWindow.ElectronWindow,
    ElectronWindow.ElectronWindow.of({
      create: () => Effect.die("ElectronWindow.create unused in this test"),
      loadUrl: () => Effect.void,
      currentMainOrFirst: Effect.succeed(Option.none()),
      focusedMainOrFirst: Effect.succeed(Option.none()),
      setMain: () => Effect.void,
      clearMain: () => Effect.void,
      reveal: () => Effect.void,
      send: () => Effect.void,
      sendAll: (channel, ...args) =>
        Effect.sync(() => {
          pushes.push({ channel, args });
        }),
      onReadyToShow: () => Effect.void,
      onClosed: () => Effect.void,
      setWindowOpenHandler: () => Effect.void,
    }),
  );

// An inert fake for the electron-updater wrapper — not exercised while disabled.
const fakeElectronUpdaterLayer = (overrides?: { readonly checkForUpdates?: Effect.Effect<void> }) =>
  Layer.succeed(
    ElectronUpdater.ElectronUpdater,
    ElectronUpdater.ElectronUpdater.of({
      setFeedURL: () => Effect.void,
      setAutoDownload: () => Effect.void,
      setAutoInstallOnAppQuit: () => Effect.void,
      setChannel: () => Effect.void,
      checkForUpdates: overrides?.checkForUpdates ?? Effect.void,
      downloadUpdate: Effect.void,
      quitAndInstall: () => Effect.void,
      on: () => Effect.void,
    }),
  );

const environmentLayer = (isPackaged: boolean) =>
  Layer.effect(
    DesktopEnvironment.DesktopEnvironment,
    Effect.map(Path.Path, (path) =>
      DesktopEnvironment.makeWith(
        {
          dirname: "/app/apps/desktop/dist-electron",
          homeDirectory: "/home/user",
          platform: "darwin",
          appVersion: "0.0.0",
          appPath: "/app",
          isPackaged,
          resourcesPath: "/app/resources",
          appDataDirectory: Option.none(),
          xdgConfigHome: Option.none(),
          serverEntryOverride: Option.none(),
          configuredBackendPort: Option.none(),
          devServerUrl: Option.none(),
        },
        path,
      ),
    ),
  ).pipe(Layer.provide(Path.layer));

// `provideMerge` so the test can also reach DesktopAppSettings to assert on it.
const testLayer = (
  isPackaged: boolean,
  pushes: Array<Push>,
  updaterOverrides?: Parameters<typeof fakeElectronUpdaterLayer>[0],
) =>
  DesktopUpdater.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        environmentLayer(isPackaged),
        DesktopAppSettings.layerTest(),
        fakeElectronWindowLayer(pushes),
        fakeElectronUpdaterLayer(updaterOverrides),
      ),
    ),
  );

describe("DesktopUpdater", () => {
  it.effect("stays disabled and inert when the app is not packaged", () => {
    const pushes: Array<Push> = [];
    return Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;

      assert.equal((yield* updater.getState).status, "disabled");

      // The action methods are no-ops while disabled: state never leaves it.
      yield* updater.check;
      yield* updater.download;
      yield* updater.install;
      assert.equal((yield* updater.getState).status, "disabled");
    }).pipe(Effect.provide(testLayer(false, pushes)));
  });

  it.effect("setChannel persists the choice and pushes it to the renderer", () => {
    const pushes: Array<Push> = [];
    return Effect.gen(function* () {
      const updater = yield* DesktopUpdater.DesktopUpdater;
      const settings = yield* DesktopAppSettings.DesktopAppSettings;

      const next = yield* updater.setChannel("nightly");
      assert.equal(next.channel, "nightly");

      // Persisted through the settings store...
      assert.equal((yield* settings.get).updateChannel, "nightly");
      // ...and pushed to the renderer over the update-state channel.
      const last = pushes.at(-1);
      assert.equal(last?.channel, UPDATE_STATE_CHANNEL);
    }).pipe(Effect.provide(testLayer(false, pushes)));
  });

  it.effect("refuses overlapping actions and channel switches while one is in flight", () =>
    Effect.gen(function* () {
      const pushes: Array<Push> = [];
      const release = yield* Deferred.make<void>();
      const checkCalls = yield* Ref.make(0);
      const layer = testLayer(true, pushes, {
        checkForUpdates: Ref.update(checkCalls, (count) => count + 1).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
      });

      yield* Effect.gen(function* () {
        const updater = yield* DesktopUpdater.DesktopUpdater;

        const checkFiber = yield* Effect.forkChild(updater.check);
        yield* Effect.gen(function* () {
          while ((yield* Ref.get(checkCalls)) < 1) {
            yield* Effect.yieldNow;
          }
        });

        // A second action while the check is in flight is dropped...
        yield* updater.download;
        assert.equal((yield* updater.getState).status, "checking");

        // ...and a channel switch fails with the typed in-progress error.
        const error = yield* Effect.flip(updater.setChannel("nightly"));
        assert.instanceOf(error, DesktopUpdater.DesktopUpdateActionInProgressError);
        assert.equal(error.action, "check");

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(checkFiber);

        // Once the action completes the channel can change again.
        const next = yield* updater.setChannel("nightly");
        assert.equal(next.channel, "nightly");
      }).pipe(Effect.provide(layer));
    }),
  );
});
