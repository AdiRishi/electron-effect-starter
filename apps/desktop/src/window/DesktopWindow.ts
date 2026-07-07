import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import type { DesktopBackendStartConfig } from "../backend/DesktopBackendConfiguration.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { MENU_ACTION_CHANNEL } from "../ipc/channels.ts";

// Owns the main BrowserWindow: creates it with the hardened webPreferences,
// loads the server (or dev) URL, and reveals it on `ready-to-show`. A
// readiness latch (`backendReadyRef`) gates window creation until the backend
// reports ready — set/cleared by the backend manager's onReady/onNotReady.

type DesktopWindowRuntimeServices =
  | DesktopEnvironment.DesktopEnvironment
  | ElectronShell.ElectronShell
  | ElectronTheme.ElectronTheme
  | ElectronWindow.ElectronWindow;

export type DesktopWindowError = ElectronWindow.ElectronWindowCreateError;

export class DesktopWindow extends Context.Service<
  DesktopWindow,
  {
    // Reveal the main window, creating it first if the backend is ready
    // (macOS dock-click / second-instance behaviour).
    readonly activate: Effect.Effect<void, DesktopWindowError>;
    // Marks the backend ready and opens the main window. Reports the resolved
    // config for the readiness log; the renderer is served same-origin so the
    // URL is derived from the environment, not this callback.
    readonly handleBackendReady: (
      config: DesktopBackendStartConfig,
    ) => Effect.Effect<void, DesktopWindowError>;
    // Clears the latch so a dock-click while the backend is down can't open a
    // window pointing at nothing.
    readonly handleBackendNotReady: Effect.Effect<void>;
    readonly dispatchMenuAction: (action: string) => Effect.Effect<void, DesktopWindowError>;
    // Builds the native application menu and installs it. Call once, after the
    // app is ready; menu clicks dispatch actions to the renderer.
    readonly installApplicationMenu: Effect.Effect<void>;
  }
>()("@app/desktop/window/DesktopWindow") {}

const { logInfo, logWarning } = makeComponentLogger("desktop-window");

function initialBackgroundColor(shouldUseDarkColors: boolean): string {
  return shouldUseDarkColors ? "#0a0a0a" : "#ffffff";
}

// The renderer origin: the dev web server in development, otherwise the local
// backend (which serves the built web app same-origin).
function resolveApplicationUrl(
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
): string {
  return Option.match(environment.devServerUrl, {
    onNone: () => `http://127.0.0.1:${environment.defaultBackendPort}`,
    onSome: (url) => url.href,
  });
}

// A minimal cross-platform application menu. The custom items dispatch string
// actions to the renderer (received via preload's `onMenuAction`); everything
// else uses Electron's built-in roles. This is the template the renderer's
// menu-action handler is driven by — extend it with your own commands.
function buildApplicationMenuTemplate(
  appName: string,
  platform: string,
  onAction: (action: string) => void,
): Electron.MenuItemConstructorOptions[] {
  const isMac = platform === "darwin";
  const template: Electron.MenuItemConstructorOptions[] = [];
  if (isMac) {
    template.push({ role: "appMenu" });
  }
  template.push(
    {
      label: "File",
      submenu: [
        {
          label: "Preferences…",
          accelerator: "CmdOrCtrl+,",
          click: () => onAction("preferences"),
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    {
      label: "Help",
      submenu: [{ label: `About ${appName}`, click: () => onAction("about") }],
    },
  );
  return template;
}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const electronShell = yield* ElectronShell.ElectronShell;
  const electronTheme = yield* ElectronTheme.ElectronTheme;
  const electronWindow = yield* ElectronWindow.ElectronWindow;

  const backendReadyRef = yield* Ref.make(false);
  const applicationUrlRef = yield* Ref.make(resolveApplicationUrl(environment));
  const context = yield* Effect.context<DesktopWindowRuntimeServices>();
  const runPromise = Effect.runPromiseWith(context);

  const createWindow = Effect.fn("desktop.window.createWindow")(function* () {
    const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
    const applicationUrl = yield* Ref.get(applicationUrlRef);
    const window = yield* electronWindow.create({
      width: 1100,
      height: 780,
      minWidth: 840,
      minHeight: 620,
      show: false,
      backgroundColor: initialBackgroundColor(shouldUseDarkColors),
      title: environment.displayName,
      webPreferences: {
        preload: environment.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    // Open http/https links externally instead of navigating the shell.
    yield* electronWindow.setWindowOpenHandler(window, ({ url }) => {
      if (Option.isSome(ElectronShell.parseSafeExternalUrl(url))) {
        void runPromise(electronShell.openExternal(url));
      }
      return { action: "deny" };
    });

    yield* electronWindow.onReadyToShow(window, () => {
      void runPromise(electronWindow.reveal(window));
    });
    yield* electronWindow.onClosed(window, () => {
      void runPromise(electronWindow.clearMain(Option.some(window)));
    });

    yield* electronWindow.loadUrl(window, applicationUrl).pipe(
      Effect.catch((error) =>
        logWarning("main window failed to load", {
          url: applicationUrl,
          message: error.message,
        }),
      ),
    );
    return window;
  });

  const createMain = Effect.gen(function* () {
    const window = yield* createWindow();
    yield* electronWindow.setMain(window);
    yield* logInfo("main window created");
    return window;
  }).pipe(Effect.withSpan("desktop.window.createMain"));

  const createMainIfBackendReady = Effect.gen(function* () {
    if (!(yield* Ref.get(backendReadyRef))) return;
    const existing = yield* electronWindow.currentMainOrFirst;
    if (Option.isSome(existing)) return;
    yield* createMain;
  }).pipe(Effect.withSpan("desktop.window.createMainIfBackendReady"));

  // Re-open the window first if it can point at a ready backend; if none exists
  // (e.g. a menu click during startup) there is nothing to receive the action.
  const dispatchMenuAction = Effect.fn("desktop.window.dispatchMenuAction")(function* (
    action: string,
  ) {
    yield* createMainIfBackendReady;
    const window = yield* electronWindow.currentMainOrFirst;
    if (Option.isNone(window)) return;
    yield* electronWindow.send(window.value, MENU_ACTION_CHANNEL, action);
    yield* electronWindow.reveal(window.value);
  });

  // Menu clicks arrive as raw Electron callbacks, so bridge each back into the
  // Effect world via `runPromise` (a dispatch failure is logged, not thrown).
  const installApplicationMenu = Effect.gen(function* () {
    const template = buildApplicationMenuTemplate(
      environment.displayName,
      environment.platform,
      (action) => {
        void runPromise(dispatchMenuAction(action).pipe(Effect.ignore({ log: true })));
      },
    );
    yield* electronMenu.setApplicationMenu(template);
  }).pipe(Effect.withSpan("desktop.window.installApplicationMenu"));

  return DesktopWindow.of({
    activate: Effect.gen(function* () {
      const existing = yield* electronWindow.currentMainOrFirst;
      if (Option.isSome(existing)) {
        yield* electronWindow.reveal(existing.value);
        return;
      }
      yield* createMainIfBackendReady;
    }).pipe(Effect.withSpan("desktop.window.activate")),
    handleBackendReady: Effect.fn("desktop.window.handleBackendReady")(function* (config) {
      // In production the window loads the backend's own origin; in dev it stays
      // on the web dev server. Update the URL BEFORE opening the ready latch so
      // a concurrent `activate` (dock click) can't create a window against the
      // stale default-port URL.
      if (!environment.isDevelopment) {
        yield* Ref.set(applicationUrlRef, config.httpBaseUrl.href);
      }
      yield* Ref.set(backendReadyRef, true);
      yield* logInfo("backend ready", { url: config.httpBaseUrl.href });
      yield* createMainIfBackendReady;
    }),
    handleBackendNotReady: Ref.set(backendReadyRef, false).pipe(
      Effect.withSpan("desktop.window.handleBackendNotReady"),
    ),
    dispatchMenuAction,
    installApplicationMenu,
  });
});

export const layer = Layer.effect(DesktopWindow, make);
