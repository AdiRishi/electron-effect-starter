import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

// Bridges Electron's app events into the Effect world. `register` first claims
// the single-instance lock (a second launch quits itself; the first instance
// reveals its window on `second-instance`), then installs scoped listeners:
// `window-all-closed` and `before-quit` request shutdown (the scoped program's
// finalizers then run), and `activate` re-opens/reveals the main window (macOS
// dock behaviour).

const { logInfo } = makeComponentLogger("desktop-lifecycle");

export class DesktopLifecycle extends Context.Service<
  DesktopLifecycle,
  {
    readonly register: Effect.Effect<void, never, Scope.Scope>;
  }
>()("@app/desktop/app/DesktopLifecycle") {}

export const make = Effect.gen(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const shutdown = yield* DesktopShutdown.DesktopShutdown;
  const state = yield* DesktopState.DesktopState;
  const window = yield* DesktopWindow.DesktopWindow;
  const context = yield* Effect.context<
    DesktopWindow.DesktopWindow | DesktopState.DesktopState
  >();
  const runFork = Effect.runForkWith(context);

  const requestShutdown = Effect.gen(function* () {
    yield* Ref.set(state.quitting, true);
    yield* shutdown.request;
  });

  const register = Effect.gen(function* () {
    if (!(yield* electronApp.requestSingleInstanceLock)) {
      yield* logInfo("another instance holds the lock; quitting");
      yield* electronApp.quit;
      return yield* Effect.interrupt;
    }
    yield* electronApp.on("second-instance", () => {
      runFork(window.activate.pipe(Effect.ignore({ log: true })));
    });

    yield* electronApp.on("window-all-closed", () => {
      runFork(
        logInfo("all windows closed; requesting shutdown").pipe(
          Effect.andThen(requestShutdown),
        ),
      );
    });
    yield* electronApp.on("before-quit", () => {
      runFork(requestShutdown);
    });
    yield* electronApp.on("activate", () => {
      runFork(window.activate.pipe(Effect.ignore({ log: true })));
    });
  });

  return DesktopLifecycle.of({ register });
});

export const layer = Layer.effect(DesktopLifecycle, make);
