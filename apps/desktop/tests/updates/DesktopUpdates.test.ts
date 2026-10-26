import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as DesktopState from "../../src/app/DesktopState.ts";
import * as ElectronUpdater from "../../src/electron/ElectronUpdater.ts";
import * as DesktopUpdates from "../../src/updates/DesktopUpdates.ts";
import { makeUpdatesHarness, type UpdatesHarnessOptions } from "../support/updatesHarness.ts";

const configured = (options: UpdatesHarnessOptions) => {
  const harness = makeUpdatesHarness(options);

  return {
    harness,
    run: <A, E>(
      body: (
        updates: DesktopUpdates.DesktopUpdates["Service"],
      ) => Effect.Effect<A, E, DesktopState.DesktopState>,
    ) =>
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        return yield* body(updates);
      }).pipe(Effect.scoped, Effect.provide(harness.layer)),
  };
};

const installerRefused = Effect.fail(
  new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
    isSilent: true,
    isForceRunAfter: true,
    cause: new Error("installer refused"),
  }),
);

describe("DesktopUpdates", () => {
  it.effect("updates Linux .deb installs and leaves other non-AppImage installs off", () =>
    Effect.gen(function* () {
      const linuxDisabledReason = (packageType: string | undefined) =>
        configured({ environment: { platform: "linux" }, packageType }).run(
          (updates) => updates.disabledReason,
        );

      assert.isTrue(Option.isNone(yield* linuxDisabledReason("deb\n")));
      assert.deepEqual(
        yield* linuxDisabledReason(undefined),
        Option.some("Automatic updates on Linux require the AppImage or the .deb package."),
      );
    }),
  );

  it.effect("stays off without checking when the build has no update feed", () => {
    const { harness, run } = configured({ appUpdateYml: undefined });

    return run((updates) =>
      Effect.gen(function* () {
        assert.deepEqual(
          yield* updates.disabledReason,
          Option.some("Automatic updates are not available because no update feed is configured."),
        );
        assert.equal(harness.checkCount(), 0);
      }),
    );
  });

  it.effect("stops the server before handing the app to the installer", () => {
    const { harness, run } = configured({});

    return run((updates) =>
      Effect.gen(function* () {
        const state = yield* DesktopState.DesktopState;
        yield* updates.install;

        assert.deepEqual(harness.installSteps, ["stopBackend", "quitAndInstall"]);
        assert.deepEqual(harness.quitAndInstallOptions, [
          { isSilent: true, isForceRunAfter: true },
        ]);
        assert.isTrue(yield* Ref.get(state.quitting));
      }),
    );
  });

  it.effect("restarts the server and reports the failure when quitAndInstall fails", () => {
    const { harness, run } = configured({ quitAndInstall: installerRefused });

    return run((updates) =>
      Effect.gen(function* () {
        const state = yield* DesktopState.DesktopState;
        yield* updates.install;

        assert.deepEqual(harness.installSteps, ["stopBackend", "quitAndInstall", "startBackend"]);
        assert.isFalse(yield* Ref.get(state.quitting));
        assert.deepEqual(
          harness.dialogs.map((dialog) => dialog.title),
          ["Update failed"],
        );
      }),
    );
  });

  it.effect("keeps a stopped server stopped when quitAndInstall fails", () => {
    const { harness, run } = configured({
      backendDesiredRunning: false,
      quitAndInstall: installerRefused,
    });

    return run((updates) =>
      Effect.gen(function* () {
        yield* updates.install;

        assert.deepEqual(harness.installSteps, ["stopBackend", "quitAndInstall"]);
      }),
    );
  });

  it.effect("restores the server when the installer reports an error after quitting began", () => {
    const { harness, run } = configured({});

    return run((updates) =>
      Effect.gen(function* () {
        const state = yield* DesktopState.DesktopState;
        yield* updates.install;
        harness.emit("error", new Error("installer exited with code 2"));
        yield* Effect.yieldNow;

        assert.deepEqual(harness.installSteps, ["stopBackend", "quitAndInstall", "startBackend"]);
        assert.isFalse(yield* Ref.get(state.quitting));
      }),
    );
  });

  it.effect("installs a downloaded update when the user chooses to restart", () => {
    const { harness, run } = configured({ dialogResponse: 0 });

    return run(() =>
      Effect.gen(function* () {
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* Effect.yieldNow;

        assert.deepEqual(harness.installSteps, ["stopBackend", "quitAndInstall"]);
      }),
    );
  });

  it.effect("leaves a downloaded update for the next quit when the user picks Later", () => {
    const { harness, run } = configured({ dialogResponse: 1 });

    return run(() =>
      Effect.gen(function* () {
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* Effect.yieldNow;

        assert.deepEqual(harness.installSteps, []);
      }),
    );
  });
});
