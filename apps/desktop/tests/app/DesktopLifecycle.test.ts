import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";

import * as DesktopEnvironment from "../../src/app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../../src/app/DesktopLifecycle.ts";
import * as DesktopShutdown from "../../src/app/DesktopShutdown.ts";
import * as DesktopState from "../../src/app/DesktopState.ts";
import * as ElectronApp from "../../src/electron/ElectronApp.ts";
import * as ElectronWindow from "../../src/electron/ElectronWindow.ts";
import * as DesktopWindow from "../../src/window/DesktopWindow.ts";

// Electron is the external seam: the fake app records listeners and quit calls.
const makeHarness = Effect.gen(function* () {
  const listeners = new Map<string, (...args: ReadonlyArray<unknown>) => void>();
  const quits = yield* Queue.unbounded<void>();
  const app = ElectronApp.ElectronApp.of({
    metadata: Effect.succeed({
      appVersion: "0.0.0",
      appPath: "/app",
      isPackaged: false,
      userDataPath: "/data",
    }),
    whenReady: Effect.void,
    requestSingleInstanceLock: Effect.succeed(true),
    quit: Queue.offer(quits, undefined).pipe(Effect.asVoid),
    exit: () => Effect.void,
    on: (eventName, listener) =>
      Effect.sync(() => {
        listeners.set(eventName, (...args) => Reflect.apply(listener, undefined, args));
      }),
    onBeforeQuitForUpdate: () => Effect.void,
  });
  const layer = Layer.mergeAll(
    Layer.succeed(ElectronApp.ElectronApp, app),
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
    Layer.succeed(
      DesktopEnvironment.DesktopEnvironment,
      DesktopEnvironment.DesktopEnvironment.of({
        platform: "linux",
        isPackaged: false,
        isDevelopment: false,
        appVersion: "0.0.0",
        displayName: "Test",
        stateDir: "/data",
        serverBaseDir: "/data/server",
        logDir: "/data/logs",
        appRoot: "/app",
        backendEntryPath: "/app/apps/server/dist/bin.mjs",
        clientAssetsDir: "/app/apps/server/dist/client",
        preloadPath: "/app/preload.cjs",
        compileCachePath: "/app/compileCache.cjs",
        devServerUrl: Option.none(),
        configuredBackendPort: Option.none(),
        disableAutoUpdate: true,
      }),
    ),
    DesktopShutdown.layer,
    DesktopState.layer,
  );
  return { listeners, quits, layer };
});

const makeQuitEvent = () => {
  let prevented = false;
  return {
    event: { preventDefault: () => void (prevented = true) },
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
        harness.listeners.get("before-quit")?.(first.event);
        assert.isTrue(first.wasPrevented());
        yield* shutdown.awaitRequest;
        assert.isTrue(yield* Ref.get(state.quitting));

        // The app program's finalizer marks shutdown complete once the server has stopped.
        yield* shutdown.markComplete;
        yield* Queue.take(harness.quits);

        const second = makeQuitEvent();
        harness.listeners.get("before-quit")?.(second.event);
        assert.isFalse(second.wasPrevented());
      }).pipe(Effect.provide(Layer.merge(DesktopLifecycle.layer, harness.layer)), Effect.scoped);
    }),
  );
});
