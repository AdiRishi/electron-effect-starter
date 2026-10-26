import * as HostProcess from "@app/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import type * as Electron from "electron";

import * as ElectronWindow from "../../src/electron/ElectronWindow.ts";

const fakeWindow = (id: number, destroy: () => void) =>
  // SAFETY: destroyAll reads only the window's id and destroy method.
  ({ id, destroy }) as Electron.BrowserWindow;

describe("ElectronWindow", () => {
  it.effect("preserves destroy failures and continues with later windows", () =>
    Effect.gen(function* () {
      const cause = new Error("window destroy failed");
      let laterWindowDestroyed = false;

      const windows = [
        fakeWindow(43, () => {
          throw cause;
        }),
        fakeWindow(44, () => {
          laterWindowDestroyed = true;
        }),
      ];

      const layer = Layer.effect(
        ElectronWindow.ElectronWindow,
        ElectronWindow.make({ getAllWindows: () => windows }),
      ).pipe(Layer.provide(Layer.succeed(HostProcess.Platform, "linux")));

      const electronWindow = yield* ElectronWindow.ElectronWindow.pipe(Effect.provide(layer));
      const exit = yield* Effect.exit(electronWindow.destroyAll);

      assert.isTrue(Exit.isFailure(exit));

      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronWindow.ElectronWindowOperationError);
        assert.equal(error.operation, "destroy-window");
        assert.equal(error.windowId, 43);
        assert.strictEqual(error.cause, cause);
      }

      assert.isTrue(laterWindowDestroyed);
    }),
  );
});
