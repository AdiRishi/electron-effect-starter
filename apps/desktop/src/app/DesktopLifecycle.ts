import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";

// Bridges Electron's app events into the Effect world. `register` first claims
// the single-instance lock (a second launch quits itself; the first instance
// reveals its window on `second-instance`), then installs scoped listeners.
//
// Every quit path funnels through `before-quit`: the first pass cancels the
// quit with `event.preventDefault()`, requests shutdown (releasing the scoped
// program so its finalizers SIGTERM the backend child), waits for the
// finalizers to complete, and only then re-issues the quit — which the
// `quitAllowed` latch lets through. Without the barrier Electron tears the
// process down while the backend stop is still in flight, orphaning the child.
// `window-all-closed` quits on Windows/Linux; on macOS the app stays resident
// (dock `activate` re-opens the window). SIGINT/SIGTERM take the same
// coordinated path instead of killing the process mid-teardown.

const { logInfo } = makeComponentLogger("desktop-lifecycle");

export class DesktopLifecycle extends Context.Service<
  DesktopLifecycle,
  {
    readonly register: Effect.Effect<void, never, Scope.Scope>;
  }
>()("@app/desktop/app/DesktopLifecycle") {}

// Scoped listener on an arbitrary emitter (used for `process` signals; Electron
// app events go through the ElectronApp wrapper's own scoped `on`).
const addScopedProcessListener = (
  signal: "SIGINT" | "SIGTERM",
  listener: () => void,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      process.on(signal, listener);
    }),
    () =>
      Effect.sync(() => {
        process.removeListener(signal, listener);
      }),
  ).pipe(Effect.asVoid);

export const make = Effect.gen(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const shutdown = yield* DesktopShutdown.DesktopShutdown;
  const state = yield* DesktopState.DesktopState;
  const window = yield* DesktopWindow.DesktopWindow;
  const context = yield* Effect.context<DesktopWindow.DesktopWindow | DesktopState.DesktopState>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);

  const requestShutdownAndWait = Effect.gen(function* () {
    yield* Ref.set(state.quitting, true);
    yield* shutdown.request;
    yield* shutdown.awaitComplete;
  });

  const register = Effect.gen(function* () {
    if (!(yield* electronApp.requestSingleInstanceLock)) {
      yield* logInfo("another instance holds the lock; quitting");
      yield* electronApp.quit;
      return yield* Effect.interrupt;
    }

    // Flips to true once shutdown finalizers have completed; the second
    // `before-quit` pass (or a signal-initiated quit) then proceeds unblocked.
    let quitAllowed = false;

    yield* electronApp.on("second-instance", () => {
      runFork(window.activate.pipe(Effect.ignore({ log: true })));
    });

    yield* electronApp.on("window-all-closed", () => {
      runFork(
        Effect.gen(function* () {
          // macOS convention: stay resident; the dock `activate` re-opens.
          if (environment.platform === "darwin") return;
          if (yield* Ref.get(state.quitting)) return;
          yield* logInfo("all windows closed; quitting");
          yield* electronApp.quit;
        }),
      );
    });

    yield* electronApp.on("before-quit", (event: Electron.Event) => {
      if (quitAllowed) {
        runFork(Ref.set(state.quitting, true));
        return;
      }
      event.preventDefault();
      void runPromise(
        logInfo("before-quit received; awaiting graceful shutdown").pipe(
          Effect.andThen(requestShutdownAndWait),
        ),
      ).finally(() => {
        quitAllowed = true;
        runFork(electronApp.quit);
      });
    });

    yield* electronApp.on("activate", () => {
      runFork(window.activate.pipe(Effect.ignore({ log: true })));
    });

    // Convert OS signals into the same coordinated quit. Windows has no
    // meaningful SIGINT/SIGTERM delivery for GUI apps.
    if (environment.platform !== "win32") {
      const quitFromSignal = (signal: "SIGINT" | "SIGTERM") => {
        void runPromise(
          Effect.gen(function* () {
            const wasQuitting = yield* Ref.getAndSet(state.quitting, true);
            if (wasQuitting) return;
            yield* logInfo("process signal received; shutting down", { signal });
            yield* shutdown.request;
            yield* shutdown.awaitComplete;
            quitAllowed = true;
            yield* electronApp.quit;
          }),
        );
      };
      yield* addScopedProcessListener("SIGINT", () => {
        quitFromSignal("SIGINT");
      });
      yield* addScopedProcessListener("SIGTERM", () => {
        quitFromSignal("SIGTERM");
      });
    }
  });

  return DesktopLifecycle.of({ register });
});

export const layer = Layer.effect(DesktopLifecycle, make);
