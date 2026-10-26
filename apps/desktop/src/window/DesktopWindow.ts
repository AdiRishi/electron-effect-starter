import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopLogger from "../app/DesktopLogger.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronScreen from "../electron/ElectronScreen.ts";
import { getDesktopUrl } from "../electron/ElectronProtocol.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

const MAIN_WINDOW_BOUNDS_PERSIST_DEBOUNCE_MS = 500;
const DEVELOPMENT_LOAD_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000] as const;

// Chromium net errors a restarting Vite server produces: aborted, refused, reset, timed out.
const DEVELOPMENT_RETRYABLE_LOAD_ERROR_CODES = new Set([-2, -7, -9, -102, -105, -106, -118]);
const RENDERER_RECOVERY_RELOAD_DELAY_MS = 500;
const RENDERER_RECOVERY_MAX_ATTEMPTS = 3;
const RENDERER_RECOVERY_WINDOW_MS = 60_000;

const { logInfo, logWarning } = DesktopLogger.forComponent("desktop-window");

function getWindowBackgroundColor(shouldUseDarkColors: boolean): string {
  return shouldUseDarkColors ? "#09090b" : "#ffffff";
}

type DisplayBounds = Pick<Electron.Rectangle, "x" | "y" | "width" | "height">;

function windowFitsWithinDisplay(
  windowBounds: DesktopAppSettings.DesktopWindowBounds,
  displayBounds: DisplayBounds,
): boolean {
  return (
    windowBounds.x >= displayBounds.x &&
    windowBounds.y >= displayBounds.y &&
    windowBounds.x + windowBounds.width <= displayBounds.x + displayBounds.width &&
    windowBounds.y + windowBounds.height <= displayBounds.y + displayBounds.height
  );
}

function windowBoundsEqual(
  left: DesktopAppSettings.DesktopWindowBounds,
  right: DesktopAppSettings.DesktopWindowBounds,
): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

export function resolveInitialMainWindowBounds(
  persistedBounds: DesktopAppSettings.DesktopWindowBounds | null,
  displays: readonly DisplayBounds[],
): DesktopAppSettings.DesktopWindowBounds | typeof DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE {
  if (
    persistedBounds !== null &&
    displays.some((display) => windowFitsWithinDisplay(persistedBounds, display))
  ) {
    return persistedBounds;
  }

  return DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE;
}

function isSameOriginRendererNavigation(input: {
  readonly applicationUrl: string;
  readonly navigationUrl: string;
}): boolean {
  try {
    return new URL(input.applicationUrl).origin === new URL(input.navigationUrl).origin;
  } catch {
    return false;
  }
}

function isRetryableDevelopmentRendererLoadFailure(input: {
  readonly applicationUrl: string;
  readonly errorCode: number;
  readonly isMainFrame: boolean;
  readonly validatedUrl: string;
}): boolean {
  return (
    input.isMainFrame &&
    DEVELOPMENT_RETRYABLE_LOAD_ERROR_CODES.has(input.errorCode) &&
    isSameOriginRendererNavigation({
      applicationUrl: input.applicationUrl,
      navigationUrl: input.validatedUrl,
    })
  );
}

type RevealSubscription = (listener: () => void) => void;

// Linux can skip "ready-to-show", so the window reveals on whichever event fires first.
function bindFirstRevealTrigger(
  subscribers: readonly RevealSubscription[],
  reveal: () => void,
): void {
  let revealed = false;

  const fire = () => {
    if (revealed) return;
    revealed = true;
    reveal();
  };

  for (const subscribe of subscribers) {
    subscribe(fire);
  }
}

/** Spelling suggestions, link copying and the edit roles; everything else is the renderer's. */
function buildContextMenuTemplate(input: {
  readonly params: Electron.ContextMenuParams;
  readonly replaceMisspelling: (suggestion: string) => void;
  readonly copyLink: (url: string) => void;
}): Electron.MenuItemConstructorOptions[] {
  const { params } = input;
  const menuTemplate: Electron.MenuItemConstructorOptions[] = [];

  if (params.misspelledWord) {
    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
      menuTemplate.push({ label: suggestion, click: () => input.replaceMisspelling(suggestion) });
    }

    if (params.dictionarySuggestions.length === 0) {
      menuTemplate.push({ label: "No suggestions", enabled: false });
    }

    menuTemplate.push({ type: "separator" });
  }

  if (Option.isSome(ElectronShell.parseSafeExternalUrl(params.linkURL))) {
    menuTemplate.push(
      { label: "Copy Link", click: () => input.copyLink(params.linkURL) },
      { type: "separator" },
    );
  }

  menuTemplate.push(
    { role: "cut", enabled: params.editFlags.canCut },
    { role: "copy", enabled: params.editFlags.canCopy },
    { role: "paste", enabled: params.editFlags.canPaste },
    { role: "selectAll", enabled: params.editFlags.canSelectAll },
  );

  return menuTemplate;
}

/** The main window: opened once the server is ready, recovered when its renderer dies. */
export class DesktopWindow extends Context.Service<
  DesktopWindow,
  {
    readonly activate: Effect.Effect<void>;
    readonly handleBackendReady: (httpBaseUrl: URL) => Effect.Effect<void>;
    readonly handleBackendNotReady: Effect.Effect<void>;
    /** Saves the main window's bounds now instead of after the debounce; quitting calls it. */
    readonly flushMainWindowBounds: Effect.Effect<void>;
    /** Repaints every window's background after the system switches light and dark mode. */
    readonly syncAppearance: Effect.Effect<void>;
  }
>()("@app/desktop/window/DesktopWindow") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopState = yield* DesktopState.DesktopState;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const electronScreen = yield* ElectronScreen.ElectronScreen;
  const electronShell = yield* ElectronShell.ElectronShell;
  const electronTheme = yield* ElectronTheme.ElectronTheme;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const applicationUrl = getDesktopUrl(environment.isDevelopment);
  let flushMainWindowBounds: Effect.Effect<void> = Effect.void;

  const openExternally = (url: string) => {
    if (Option.isSome(ElectronShell.parseSafeExternalUrl(url))) {
      runFork(electronShell.openExternal(url));
    }
  };

  const createMain = Effect.gen(function* () {
    if (yield* Ref.get(desktopState.quitting)) return;
    const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
    const persistedSettings = yield* desktopSettings.get;
    const persistedBounds = persistedSettings.mainWindowBounds;

    const displayBounds = yield* electronScreen.displayBounds.pipe(
      Effect.catchCause((cause) =>
        logWarning("failed to read connected displays; using defaults", cause).pipe(
          Effect.as<ReadonlyArray<Electron.Rectangle>>([]),
        ),
      ),
    );

    const initialBounds = resolveInitialMainWindowBounds(persistedBounds, displayBounds);
    const restoredPersistedBounds = persistedBounds !== null && initialBounds === persistedBounds;

    if (persistedBounds !== null && !restoredPersistedBounds) {
      yield* logWarning("saved main window bounds could not be restored; using defaults");
    }

    const window = yield* electronWindow.create({
      ...initialBounds,
      minWidth: DesktopAppSettings.MIN_MAIN_WINDOW_SIZE.width,
      minHeight: DesktopAppSettings.MIN_MAIN_WINDOW_SIZE.height,
      show: false,
      title: environment.displayName,
      backgroundColor: getWindowBackgroundColor(shouldUseDarkColors),
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

    // A quit can start while the native window is being created.
    if (yield* Ref.get(desktopState.quitting)) {
      yield* electronWindow.destroyAll;

      return;
    }

    yield* electronWindow.setMain(window);

    let boundsPersistFiber: Fiber.Fiber<void> | undefined;
    let pendingBoundsPersistFiber: Fiber.Fiber<void> | undefined;
    // Bounds that could not be restored stay saved until the user moves or resizes the window.
    let boundsPersistenceEnabled = persistedBounds === null || restoredPersistedBounds;

    const readPersistableBounds = (): DesktopAppSettings.DesktopWindowBounds | null => {
      if (window.isDestroyed()) return null;

      const bounds =
        window.isFullScreen() || window.isMaximized() || window.isMinimized()
          ? window.getNormalBounds()
          : window.getBounds();

      return DesktopAppSettings.normalizeMainWindowBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      });
    };

    const fallbackWindowBounds = boundsPersistenceEnabled ? null : readPersistableBounds();
    const fallbackWindowMaximized = persistedSettings.mainWindowMaximized;

    const persistCurrentBounds = (): Fiber.Fiber<void> | undefined => {
      if (!boundsPersistenceEnabled) return pendingBoundsPersistFiber;
      const bounds = readPersistableBounds();

      if (bounds === null) return pendingBoundsPersistFiber;

      pendingBoundsPersistFiber = runFork(
        desktopSettings.setMainWindowBounds(bounds, window.isMaximized()).pipe(
          Effect.asVoid,
          Effect.catchTags({
            DesktopSettingsWriteError: (error) =>
              logWarning("failed to persist main window bounds", error),
          }),
        ),
      );

      return pendingBoundsPersistFiber;
    };

    const clearBoundsPersist = () => {
      if (boundsPersistFiber === undefined) return;
      const fiber = boundsPersistFiber;
      boundsPersistFiber = undefined;
      runFork(Fiber.interrupt(fiber));
    };

    const scheduleBoundsPersist = () => {
      if (!boundsPersistenceEnabled) {
        const currentBounds = readPersistableBounds();

        if (
          currentBounds === null ||
          (fallbackWindowBounds !== null &&
            windowBoundsEqual(currentBounds, fallbackWindowBounds) &&
            window.isMaximized() === fallbackWindowMaximized)
        ) {
          return;
        }
      }

      boundsPersistenceEnabled = true;
      clearBoundsPersist();

      boundsPersistFiber = runFork(
        Effect.sleep(MAIN_WINDOW_BOUNDS_PERSIST_DEBOUNCE_MS).pipe(
          Effect.andThen(
            Effect.sync(() => {
              boundsPersistFiber = undefined;
              void persistCurrentBounds();
            }),
          ),
        ),
      );
    };

    const flushBoundsPersist = Effect.sync(() => {
      clearBoundsPersist();

      return persistCurrentBounds();
    }).pipe(Effect.flatMap((fiber) => (fiber === undefined ? Effect.void : Fiber.join(fiber))));

    flushMainWindowBounds = flushBoundsPersist;

    window.on("resize", scheduleBoundsPersist);
    window.on("move", scheduleBoundsPersist);
    window.on("maximize", scheduleBoundsPersist);
    window.on("unmaximize", scheduleBoundsPersist);
    window.on("close", () => {
      runFork(flushBoundsPersist);
    });

    window.webContents.on("context-menu", (event, params) => {
      event.preventDefault();

      if (window.isDestroyed()) return;

      runFork(
        electronMenu.popupTemplate({
          window,
          template: buildContextMenuTemplate({
            params,
            replaceMisspelling: (suggestion) => {
              if (!window.isDestroyed()) window.webContents.replaceMisspelling(suggestion);
            },
            copyLink: (url) => {
              runFork(electronShell.copyText(url));
            },
          }),
          ...(params.frame ? { frame: params.frame } : {}),
        }),
      );
    });

    // New windows never open in-app; web links go to the system browser.
    window.webContents.setWindowOpenHandler(({ url }) => {
      openExternally(url);

      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (isSameOriginRendererNavigation({ applicationUrl, navigationUrl: url })) return;
      event.preventDefault();
      openExternally(url);
    });

    let developmentLoadRetryIndex = 0;
    let developmentLoadRetryFiber: Fiber.Fiber<void> | undefined;
    let rendererRecoveryTimestamps: ReadonlyArray<number> = [];

    const loadApplication = () => {
      if (!window.isDestroyed()) void window.loadURL(applicationUrl).catch(() => undefined);
    };

    const clearDevelopmentLoadRetry = () => {
      if (developmentLoadRetryFiber === undefined) return;
      const retryFiber = developmentLoadRetryFiber;
      developmentLoadRetryFiber = undefined;
      runFork(Fiber.interrupt(retryFiber));
    };

    // At most one retry is in flight; failures while it waits do not stack more loads.
    const scheduleDevelopmentLoadRetry = () => {
      if (developmentLoadRetryFiber !== undefined || window.isDestroyed()) return undefined;

      const retryInMs =
        DEVELOPMENT_LOAD_RETRY_DELAYS_MS[
          Math.min(developmentLoadRetryIndex, DEVELOPMENT_LOAD_RETRY_DELAYS_MS.length - 1)
        ] ?? 2_000;

      developmentLoadRetryIndex += 1;

      developmentLoadRetryFiber = runFork(
        Effect.sleep(retryInMs).pipe(
          Effect.andThen(
            Effect.sync(() => {
              developmentLoadRetryFiber = undefined;
              loadApplication();
            }),
          ),
        ),
      );

      return retryInMs;
    };

    window.webContents.on("did-finish-load", () => {
      // A cross-origin page finishing must not reset the backoff for the app's own URL.
      if (
        environment.isDevelopment &&
        !isSameOriginRendererNavigation({
          applicationUrl,
          navigationUrl: window.webContents.getURL(),
        })
      ) {
        return;
      }

      clearDevelopmentLoadRetry();
      developmentLoadRetryIndex = 0;
    });
    window.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
        if (!isMainFrame) return;

        const retryInMs =
          environment.isDevelopment &&
          isRetryableDevelopmentRendererLoadFailure({
            applicationUrl,
            errorCode,
            isMainFrame,
            validatedUrl,
          })
            ? scheduleDevelopmentLoadRetry()
            : undefined;

        runFork(
          logWarning("main window failed to load", {
            errorCode,
            errorDescription,
            url: validatedUrl,
            ...(retryInMs === undefined ? {} : { retryInMs }),
          }),
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

    const revealSubscribers: RevealSubscription[] = [(fire) => window.once("ready-to-show", fire)];

    if (environment.platform === "linux") {
      revealSubscribers.push((fire) => window.webContents.once("did-finish-load", fire));
    }

    bindFirstRevealTrigger(revealSubscribers, () => {
      if (!window.isDestroyed()) window.webContents.setBackgroundThrottling(true);

      if (persistedSettings.mainWindowMaximized) window.maximize();
      runFork(electronWindow.reveal(window));
    });
    window.on("closed", () => {
      clearDevelopmentLoadRetry();
      clearBoundsPersist();
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
    flushMainWindowBounds: Effect.suspend(() => flushMainWindowBounds).pipe(
      Effect.withSpan("DesktopWindow.flushMainWindowBounds"),
    ),
    syncAppearance: Effect.gen(function* () {
      const backgroundColor = getWindowBackgroundColor(yield* electronTheme.shouldUseDarkColors);
      yield* electronWindow.syncAllAppearance((window) =>
        Effect.sync(() => window.setBackgroundColor(backgroundColor)),
      );
    }).pipe(Effect.withSpan("DesktopWindow.syncAppearance")),
  });
});

export const layer = Layer.effect(DesktopWindow, make);
