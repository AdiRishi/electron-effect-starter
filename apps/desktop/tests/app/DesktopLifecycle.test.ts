import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopLifecycle from "../../src/app/DesktopLifecycle.ts";
import * as DesktopShutdown from "../../src/app/DesktopShutdown.ts";
import * as DesktopState from "../../src/app/DesktopState.ts";
import * as ElectronApp from "../../src/electron/ElectronApp.ts";
import { makeFakeElectronApp } from "../support/electronApp.ts";
import { layerTestEnvironment } from "../support/environment.ts";
import {
  layerFakeDesktopWindow,
  layerFakeElectronTheme,
  layerFakeElectronWindow,
} from "../support/windows.ts";

const makeQuitEvent = () => {
  let prevented = 0;

  return {
    event: {
      preventDefault: () => void (prevented += 1),
      get defaultPrevented() {
        return prevented > 0;
      },
    },
    preventedCount: () => prevented,
  };
};

const layerLifecycle = (input: {
  readonly app: Partial<ElectronApp.ElectronApp["Service"]>;
  readonly platform?: NodeJS.Platform;
  readonly destroyAll?: Effect.Effect<void>;
  readonly activate?: Effect.Effect<void>;
  readonly flushMainWindowBounds?: Effect.Effect<void>;
  readonly shutdown?: Layer.Layer<DesktopShutdown.DesktopShutdown>;
}) => {
  const app = makeFakeElectronApp(input.app);

  const layer = DesktopLifecycle.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        app.layer,
        layerFakeElectronTheme(),
        layerFakeElectronWindow(input.destroyAll ? { destroyAll: input.destroyAll } : {}),
        layerFakeDesktopWindow({
          ...(input.activate ? { activate: input.activate } : {}),
          ...(input.flushMainWindowBounds
            ? { flushMainWindowBounds: input.flushMainWindowBounds }
            : {}),
        }),
        layerTestEnvironment({ platform: input.platform ?? "darwin" }),
        input.shutdown ?? DesktopShutdown.layer,
        DesktopState.layer,
      ),
    ),
  );

  return { app, layer };
};

const register = Effect.gen(function* () {
  const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
  yield* lifecycle.register;
});

describe("DesktopLifecycle", () => {
  it.effect("holds the first quit until the server has shut down, then quits for real", () =>
    Effect.gen(function* () {
      const quits = yield* Queue.unbounded<void>();

      const { app, layer } = layerLifecycle({
        app: { quit: Queue.offer(quits, undefined).pipe(Effect.asVoid) },
      });

      yield* Effect.gen(function* () {
        yield* register;
        const shutdown = yield* DesktopShutdown.DesktopShutdown;
        const state = yield* DesktopState.DesktopState;

        const first = makeQuitEvent();
        app.emit("before-quit", first.event);
        assert.equal(first.preventedCount(), 1);
        yield* shutdown.awaitRequest;
        assert.isTrue(yield* Ref.get(state.quitting));

        // The app program's finalizer marks shutdown complete once the server has stopped.
        yield* shutdown.markComplete;
        yield* Queue.take(quits);

        const second = makeQuitEvent();
        app.emit("before-quit", second.event);
        assert.equal(second.preventedCount(), 0);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect.each(["darwin", "win32", "linux"] satisfies ReadonlyArray<NodeJS.Platform>)(
    "lets the updater's quit event proceed on %s",
    (platform) => {
      let windowsDestroyed = false;

      const { app, layer } = layerLifecycle({
        app: {},
        platform,
        destroyAll: Effect.sync(() => {
          windowsDestroyed = true;
        }),
      });

      return Effect.gen(function* () {
        yield* register;
        app.emitBeforeQuitForUpdate();
        yield* Effect.yieldNow;

        const quit = makeQuitEvent();
        app.emit("before-quit", quit.event);

        assert.equal(
          quit.preventedCount(),
          0,
          "cancelling this event prevents the updater from completing its relaunch",
        );
        assert.isTrue(windowsDestroyed);
        const state = yield* DesktopState.DesktopState;
        assert.isTrue(yield* Ref.get(state.quitting));
      }).pipe(Effect.provide(layer), Effect.scoped);
    },
  );

  it.effect("destroys windows before waiting for backend shutdown", () =>
    Effect.gen(function* () {
      const shutdownRequested = yield* Deferred.make<void>();
      const allowShutdown = yield* Deferred.make<void>();
      const quitRequested = yield* Deferred.make<void>();
      const events: string[] = [];

      const layerShutdown = Layer.succeed(
        DesktopShutdown.DesktopShutdown,
        DesktopShutdown.DesktopShutdown.of({
          request: Effect.sync(() => events.push("request")).pipe(
            Effect.andThen(Deferred.succeed(shutdownRequested, undefined)),
            Effect.asVoid,
          ),
          awaitRequest: Deferred.await(shutdownRequested),
          markComplete: Deferred.succeed(allowShutdown, undefined).pipe(Effect.asVoid),
          awaitComplete: Deferred.await(allowShutdown),
          isComplete: Deferred.isDone(allowShutdown),
        }),
      );

      const { app, layer } = layerLifecycle({
        app: {
          quit: Effect.sync(() => events.push("quit")).pipe(
            Effect.andThen(Deferred.succeed(quitRequested, undefined)),
            Effect.asVoid,
          ),
        },
        destroyAll: Effect.sync(() => {
          events.push("destroy");
        }),
        flushMainWindowBounds: Effect.sync(() => {
          events.push("flush");
        }),
        shutdown: layerShutdown,
      });

      yield* Effect.gen(function* () {
        yield* register;
        app.emit("before-quit", makeQuitEvent().event);

        yield* Deferred.await(shutdownRequested);
        const eventsBeforeCleanup = [...events];
        yield* Deferred.succeed(allowShutdown, undefined);
        yield* Deferred.await(quitRequested);

        assert.deepEqual(eventsBeforeCleanup, ["flush", "destroy", "request"]);
        assert.deepEqual(events, ["flush", "destroy", "request", "quit"]);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("still stops the server when destroying a window fails", () =>
    Effect.gen(function* () {
      const { app, layer } = layerLifecycle({
        app: {},
        destroyAll: Effect.die(new Error("window destroy failed")),
      });

      yield* Effect.gen(function* () {
        yield* register;
        const shutdown = yield* DesktopShutdown.DesktopShutdown;
        app.emit("before-quit", makeQuitEvent().event);

        yield* shutdown.awaitRequest;
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("exits on a repeated quit only once shutdown has stalled", () =>
    Effect.gen(function* () {
      const exitCodes: number[] = [];

      // Nothing marks this shutdown complete, so it stays pending.
      const { app, layer } = layerLifecycle({
        app: {
          exit: (code) =>
            Effect.sync(() => {
              exitCodes.push(code);
            }),
        },
      });

      yield* Effect.gen(function* () {
        yield* register;
        const quit = makeQuitEvent();
        app.emit("before-quit", quit.event);
        app.emit("before-quit", quit.event);
        yield* TestClock.adjust("9999 millis");
        app.emit("before-quit", quit.event);
        assert.deepEqual(
          exitCodes,
          [],
          "a repeat before the threshold must not cut shutdown short",
        );

        yield* TestClock.adjust("1 millis");
        app.emit("before-quit", quit.event);

        assert.deepEqual(exitCodes, [0]);
        assert.equal(quit.preventedCount(), 4);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("ignores app activation while quitting", () =>
    Effect.gen(function* () {
      let activationCount = 0;

      const { app, layer } = layerLifecycle({
        app: {},
        activate: Effect.sync(() => {
          activationCount += 1;
        }),
      });

      yield* Effect.gen(function* () {
        yield* register;
        const state = yield* DesktopState.DesktopState;
        yield* Ref.set(state.quitting, true);

        app.emit("activate");

        assert.equal(activationCount, 0);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );
});
