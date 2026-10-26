import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopLogger from "../app/DesktopLogger.ts";
import * as DesktopState from "../app/DesktopState.ts";
import { getDesktopUrl } from "../electron/ElectronProtocol.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";

const DEVELOPMENT_LOAD_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000] as const;
// Chromium net errors a restarting Vite server produces: aborted, refused, reset, timed out.
const DEVELOPMENT_RETRYABLE_LOAD_ERROR_CODES = new Set([-2, -7, -9, -102, -105, -106, -118]);
const RENDERER_RECOVERY_RELOAD_DELAY_MS = 500;
const RENDERER_RECOVERY_MAX_ATTEMPTS = 3;
const RENDERER_RECOVERY_WINDOW_MS = 60_000;

const { logInfo, logWarning } = DesktopLogger.forComponent("desktop-window");

function isSameOrigin(applicationUrl: string, navigationUrl: string): boolean {
  try {
    return new URL(navigationUrl).origin === new URL(applicationUrl).origin;
  } catch {
    return false;
  }
}

/** The main window: opened once the server is ready, recovered when its renderer dies. */
export class DesktopWindow extends Context.Service<
  DesktopWindow,
  {
    readonly activate: Effect.Effect<void>;
    readonly handleBackendReady: (httpBaseUrl: URL) => Effect.Effect<void>;
    readonly handleBackendNotReady: Effect.Effect<void>;
  }
>()("@app/desktop/window/DesktopWindow") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopState = yield* DesktopState.DesktopState;
  const electronShell = yield* ElectronShell.ElectronShell;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const applicationUrl = getDesktopUrl(environment.isDevelopment);

  const openExternally = (url: string) => {
    if (Option.isSome(ElectronShell.parseSafeExternalUrl(url))) {
      runFork(electronShell.openExternal(url));
    }
  };

  const createMain = Effect.gen(function* () {
    if (yield* Ref.get(desktopState.quitting)) return;
    const window = yield* electronWindow.create({
      width: 1100,
      height: 760,
      minWidth: 640,
      minHeight: 480,
      show: false,
      title: environment.displayName,
      backgroundColor: Electron.nativeTheme.shouldUseDarkColors ? "#09090b" : "#ffffff",
      autoHideMenuBar: true,
      webPreferences: {
        preload: environment.preloadPath,
        // Hidden-renderer throttling stalls first paint; it is re-enabled after the first reveal.
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    yield* electronWindow.setMain(window);

    // New windows never open in-app; web links go to the system browser.
    window.webContents.setWindowOpenHandler(({ url }) => {
      openExternally(url);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (isSameOrigin(applicationUrl, url)) return;
      event.preventDefault();
      openExternally(url);
    });

    let developmentLoadRetryIndex = 0;
    let rendererRecoveryTimestamps: ReadonlyArray<number> = [];
    const loadApplication = () => {
      if (!window.isDestroyed()) void window.loadURL(applicationUrl).catch(() => undefined);
    };

    window.webContents.on("did-finish-load", () => {
      developmentLoadRetryIndex = 0;
    });
    window.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, url, isMainFrame) => {
        if (!isMainFrame) return;
        const retry =
          environment.isDevelopment && DEVELOPMENT_RETRYABLE_LOAD_ERROR_CODES.has(errorCode);
        const retryInMs = retry
          ? DEVELOPMENT_LOAD_RETRY_DELAYS_MS[
              Math.min(developmentLoadRetryIndex++, DEVELOPMENT_LOAD_RETRY_DELAYS_MS.length - 1)
            ]
          : undefined;
        runFork(
          logWarning("main window failed to load", {
            errorCode,
            errorDescription,
            url,
            retryInMs,
          }).pipe(
            Effect.andThen(
              retryInMs === undefined
                ? Effect.void
                : Effect.sleep(retryInMs).pipe(Effect.andThen(Effect.sync(loadApplication))),
            ),
          ),
        );
      },
    );
    window.webContents.on("render-process-gone", (_event, details) => {
      const recoverable =
        details.reason === "crashed" ||
        details.reason === "oom" ||
        details.reason === "killed" ||
        details.reason === "abnormal-exit";
      runFork(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          rendererRecoveryTimestamps = rendererRecoveryTimestamps.filter(
            (timestamp) => now - timestamp < RENDERER_RECOVERY_WINDOW_MS,
          );
          // A renderer that keeps dying is left down rather than reloaded in a loop.
          const shouldRecover =
            recoverable &&
            !window.isDestroyed() &&
            rendererRecoveryTimestamps.length < RENDERER_RECOVERY_MAX_ATTEMPTS;
          yield* logWarning("main window render process gone", {
            reason: details.reason,
            exitCode: details.exitCode,
            recovering: shouldRecover,
          });
          if (!shouldRecover) return;
          rendererRecoveryTimestamps = [...rendererRecoveryTimestamps, now];
          yield* Effect.sleep(RENDERER_RECOVERY_RELOAD_DELAY_MS);
          loadApplication();
        }),
      );
    });

    window.once("ready-to-show", () => {
      if (!window.isDestroyed()) window.webContents.setBackgroundThrottling(true);
      runFork(electronWindow.reveal(window));
    });
    window.on("closed", () => {
      runFork(electronWindow.clearMain(window));
    });

    loadApplication();
    if (environment.isDevelopment) window.webContents.openDevTools({ mode: "detach" });
    yield* logInfo("main window created");
  }).pipe(Effect.withSpan("DesktopWindow.createMain"));

  const createMainIfBackendReady = Effect.gen(function* () {
    if (yield* Ref.get(desktopState.quitting)) return;
    if (!(yield* Ref.get(desktopState.backendReady))) return;
    if (Option.isSome(yield* electronWindow.main)) return;
    yield* createMain;
  });

  return DesktopWindow.of({
    activate: Effect.gen(function* () {
      if (yield* Ref.get(desktopState.quitting)) return;
      const existing = yield* electronWindow.main;
      if (Option.isSome(existing)) return yield* electronWindow.reveal(existing.value);
      yield* createMainIfBackendReady;
    }).pipe(
      Effect.catchTags({
        ElectronWindowCreateError: (error) => logWarning("could not create the main window", error),
      }),
      Effect.withSpan("DesktopWindow.activate"),
    ),
    handleBackendReady: Effect.fn("DesktopWindow.handleBackendReady")(
      function* (httpBaseUrl: URL) {
        yield* Ref.set(desktopState.backendReady, true);
        yield* logInfo("server ready", { url: httpBaseUrl.href });
        yield* createMainIfBackendReady;
      },
      Effect.catchTags({
        ElectronWindowCreateError: (error) => logWarning("could not create the main window", error),
      }),
    ),
    handleBackendNotReady: Ref.set(desktopState.backendReady, false),
  });
});

export const layer = Layer.effect(DesktopWindow, make);
