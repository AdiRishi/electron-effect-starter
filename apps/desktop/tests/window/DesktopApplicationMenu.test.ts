import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ElectronUpdater from "../../src/electron/ElectronUpdater.ts";
import * as DesktopUpdates from "../../src/updates/DesktopUpdates.ts";
import * as DesktopApplicationMenu from "../../src/window/DesktopApplicationMenu.ts";
import {
  makeUpdatesHarness,
  type UpdaterEventPayload,
  type UpdatesHarnessOptions,
} from "../support/updatesHarness.ts";

const clickCheckForUpdates = (options: UpdatesHarnessOptions, afterClick = Effect.void) => {
  const harness = makeUpdatesHarness(options);

  return Effect.gen(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    yield* updates.configure;
    yield* DesktopApplicationMenu.handleCheckForUpdatesMenuClick;
    yield* afterClick;

    return harness;
  }).pipe(Effect.scoped, Effect.provide(harness.layer));
};

describe("DesktopApplicationMenu", () => {
  it.effect("tells the user they are up to date after a check finds nothing", () =>
    Effect.gen(function* () {
      const harness = yield* clickCheckForUpdates({
        checkForUpdates: (emit) =>
          Effect.sync(() => emit("update-not-available", { version: "1.2.3" })),
      });

      assert.deepEqual(
        harness.dialogs.map((dialog) => [dialog.title, dialog.message]),
        [["You're up to date!", "Test 1.2.3 is currently the newest version available."]],
      );
    }),
  );

  it.effect("reports a failed check with the updater's reason", () =>
    Effect.gen(function* () {
      const harness = yield* clickCheckForUpdates({
        checkForUpdates: () =>
          Effect.fail(
            new ElectronUpdater.ElectronUpdaterCheckError({
              cause: new Error("feed returned 404"),
            }),
          ),
      });

      assert.deepEqual(
        harness.dialogs.map((dialog) => [dialog.title, dialog.detail]),
        [["Update check failed", "feed returned 404"]],
      );
    }),
  );

  it.effect("explains why updates are unavailable instead of checking", () =>
    Effect.gen(function* () {
      const harness = yield* clickCheckForUpdates({ appUpdateYml: undefined });

      assert.equal(harness.checkCount(), 0);
      assert.deepEqual(
        harness.dialogs.map((dialog) => [dialog.title, dialog.detail]),
        [
          [
            "Updates unavailable",
            "Automatic updates are not available because no update feed is configured.",
          ],
        ],
      );
    }),
  );

  it.effect(
    "does not report a later background result to a user whose check found an update",
    () => {
      let emitUpdaterEvent: (eventName: string, payload: UpdaterEventPayload) => void = () =>
        undefined;

      return Effect.gen(function* () {
        const harness = yield* clickCheckForUpdates(
          {
            checkForUpdates: (emit) =>
              Effect.sync(() => {
                emitUpdaterEvent = emit;
                emit("update-available", { version: "1.2.4" });
              }),
          },
          Effect.sync(() => emitUpdaterEvent("update-not-available", { version: "1.2.4" })),
        );

        assert.deepEqual(harness.dialogs, []);
      });
    },
  );
});
