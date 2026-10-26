import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLogger from "./DesktopLogger.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";

type LifecycleServices =
  | DesktopEnvironment.DesktopEnvironment
  | DesktopShutdown.DesktopShutdown
  | DesktopState.DesktopState
  | DesktopWindow.DesktopWindow
  | ElectronApp.ElectronApp
  | ElectronTheme.ElectronTheme
  | ElectronWindow.ElectronWindow;

export class DesktopLifecycle extends Context.Service<
  DesktopLifecycle,
  { readonly register: Effect.Effect<void, never, Scope.Scope | LifecycleServices> }
>()("@app/desktop/app/DesktopLifecycle") {}

const { logInfo, logError } = DesktopLogger.forComponent("desktop-lifecycle");

interface QuitState {
  phase: "running" | "waiting" | "allowed";
  waitingSinceNanos: bigint;
}

// Longer than the server's stop budget (SIGTERM, 5s grace, SIGKILL), so a double Cmd-Q at the
// start of a normal quit cannot cut the server's stop short and orphan it.
const SHUTDOWN_STALL_THRESHOLD = Duration.seconds(10);

const requestShutdownAndWait = Effect.gen(function* () {
  const shutdown = yield* DesktopShutdown.DesktopShutdown;
  yield* shutdown.request;
  yield* shutdown.awaitComplete;
});

const startWaitingForShutdown = Effect.fn("DesktopLifecycle.startWaitingForShutdown")(function* (
  quit: QuitState,
) {
  quit.phase = "waiting";
  quit.waitingSinceNanos = yield* Clock.monotonicTimeNanos;
});

// While a quit waits on shutdown, a repeated Quit or SIGTERM is the user's only way out of a
// stalled shutdown short of SIGKILL.
const exitIfShutdownStalled = Effect.fn("DesktopLifecycle.exitIfShutdownStalled")(function* (
  quit: QuitState,
  source: string,
) {
  const pendingMs = Number(
    ((yield* Clock.monotonicTimeNanos) - quit.waitingSinceNanos) / 1_000_000n,
  );

  if (pendingMs < Duration.toMillis(SHUTDOWN_STALL_THRESHOLD)) {
    yield* logInfo("quit already in progress", { source, pendingMs });

    return;
  }

  yield* logError("shutdown stalled; exiting without it", { source, pendingMs });
  const electronApp = yield* ElectronApp.ElectronApp;
  yield* electronApp.exit(0);
});

const make = DesktopLifecycle.of({
  register: Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const electronApp = yield* ElectronApp.ElectronApp;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const electronTheme = yield* ElectronTheme.ElectronTheme;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const state = yield* DesktopState.DesktopState;
    const context = yield* Effect.context<LifecycleServices>();
    const runPromise = Effect.runPromiseWith(context);
    const quit: QuitState = { phase: "running", waitingSinceNanos: 0n };

    const handleBeforeQuit = (event: Electron.Event) => {
      if (quit.phase === "allowed") {
        void runPromise(Ref.set(state.quitting, true));

        return;
      }

      // Hold the quit until the server has stopped, then quit again for real.
      event.preventDefault();

      if (quit.phase === "waiting") {
        void runPromise(exitIfShutdownStalled(quit, "before-quit"));

        return;
      }

      void runPromise(
        Effect.gen(function* () {
          yield* startWaitingForShutdown(quit);
          yield* Ref.set(state.quitting, true);
          yield* logInfo("before-quit received");
          yield* electronWindow.destroyAll.pipe(
            Effect.catchCause((cause) =>
              logError("failed to destroy windows before shutdown", cause),
            ),
          );
          yield* requestShutdownAndWait;
        }),
      ).finally(() => {
        quit.phase = "allowed";
        void runPromise(electronApp.quit);
      });
    };

    const quitFromSignal = (signal: "SIGINT" | "SIGTERM") => {
      if (quit.phase === "waiting") {
        void runPromise(exitIfShutdownStalled(quit, signal));

        return;
      }

      void runPromise(
        Effect.gen(function* () {
          if (yield* Ref.getAndSet(state.quitting, true)) return;
          yield* startWaitingForShutdown(quit);
          yield* logInfo("process signal received", { signal });
          yield* requestShutdownAndWait;
          quit.phase = "allowed";
          yield* electronApp.quit;
        }),
      );
    };

    yield* electronTheme.onUpdated(() => {
      void runPromise(desktopWindow.syncAppearance);
    });
    yield* electronApp.onBeforeQuitForUpdate(() => {
      // The updater owns the rest of the quit, install and relaunch; cancelling the following
      // before-quit would break it. Windows are destroyed inline because the quit proceeds as
      // soon as this listener returns.
      quit.phase = "allowed";
      Effect.runSyncWith(context)(
        electronWindow.destroyAll.pipe(
          Effect.andThen(logInfo("allowing updater-controlled quit")),
          Effect.catchCause((cause) =>
            logError("failed to destroy windows before updater quit", cause),
          ),
        ),
      );
    });
    yield* electronApp.on("before-quit", handleBeforeQuit);
    yield* electronApp.on("activate", () => {
      void runPromise(
        Effect.gen(function* () {
          if (yield* Ref.get(state.quitting)) return;
          yield* desktopWindow.activate;
        }),
      );
    });
    yield* electronApp.on("second-instance", () => {
      void runPromise(desktopWindow.activate);
    });
    yield* electronApp.on("window-all-closed", () => {
      void runPromise(
        Effect.gen(function* () {
          if (environment.platform !== "darwin" && !(yield* Ref.get(state.quitting))) {
            yield* electronApp.quit;
          }
        }),
      );
    });

    if (environment.platform !== "win32") {
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        const listener = () => quitFromSignal(signal);
        yield* Effect.acquireRelease(
          Effect.sync(() => process.on(signal, listener)),
          () => Effect.sync(() => process.removeListener(signal, listener)),
        );
      }
    }
  }).pipe(Effect.withSpan("DesktopLifecycle.register")),
});

export const layer = Layer.succeed(DesktopLifecycle, make);
