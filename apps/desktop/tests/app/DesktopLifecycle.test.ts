import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";

import * as DesktopLifecycle from "../../src/app/DesktopLifecycle.ts";
import * as DesktopShutdown from "../../src/app/DesktopShutdown.ts";
import * as DesktopState from "../../src/app/DesktopState.ts";
import * as ElectronWindow from "../../src/electron/ElectronWindow.ts";
import * as DesktopWindow from "../../src/window/DesktopWindow.ts";
import { makeFakeElectronApp } from "../support/electronApp.ts";
import { layerTestEnvironment } from "../support/environment.ts";

// Electron is the external seam: the fake app records listeners and quit calls.
const makeHarness = Effect.gen(function* () {
  const quits = yield* Queue.unbounded<void>();
  const app = makeFakeElectronApp({ quit: Queue.offer(quits, undefined).pipe(Effect.asVoid) });

  const layer = Layer.mergeAll(
    app.layer,
    Layer.succeed(
      ElectronWindow.ElectronWindow,
      ElectronWindow.ElectronWindow.of({
        create: () => Effect.die("not used"),
        main: Effect.succeedNone,
        setMain: () => Effect.void,
        clearMain: () => Effect.void,
        reveal: () => Effect.void,
        destroyAll: Effect.void,
      }),
    ),
    Layer.succeed(
      DesktopWindow.DesktopWindow,
      DesktopWindow.DesktopWindow.of({
        activate: Effect.void,
        handleBackendReady: () => Effect.void,
        handleBackendNotReady: Effect.void,
      }),
    ),
    layerTestEnvironment(),
    DesktopShutdown.layer,
    DesktopState.layer,
  );

  return { emit: app.emit, quits, layer };
});

const makeQuitEvent = () => {
  let prevented = false;

  return {
    event: {
      preventDefault: () => void (prevented = true),
      get defaultPrevented() {
        return prevented;
      },
    },
    wasPrevented: () => prevented,
  };
};

describe("DesktopLifecycle", () => {
  it.effect("holds the first quit until the server has shut down, then quits for real", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
        yield* lifecycle.register;
        const shutdown = yield* DesktopShutdown.DesktopShutdown;
        const state = yield* DesktopState.DesktopState;

        const first = makeQuitEvent();
        harness.emit("before-quit", first.event);
        assert.isTrue(first.wasPrevented());
        yield* shutdown.awaitRequest;
        assert.isTrue(yield* Ref.get(state.quitting));

        // The app program's finalizer marks shutdown complete once the server has stopped.
        yield* shutdown.markComplete;
        yield* Queue.take(harness.quits);

        const second = makeQuitEvent();
        harness.emit("before-quit", second.event);
        assert.isFalse(second.wasPrevented());
      }).pipe(Effect.provide(Layer.merge(DesktopLifecycle.layer, harness.layer)), Effect.scoped);
    }),
  );
});
