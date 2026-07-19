import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Electron from "electron";

import { ServerBootstrapEnvelope } from "@app/contracts";

import * as DesktopEnvironment from "../../src/app/DesktopEnvironment.ts";
import type { DesktopBackendStartConfig } from "../../src/backend/DesktopBackendConfiguration.ts";
import * as ElectronMenu from "../../src/electron/ElectronMenu.ts";
import * as ElectronShell from "../../src/electron/ElectronShell.ts";
import * as ElectronTheme from "../../src/electron/ElectronTheme.ts";
import * as ElectronWindow from "../../src/electron/ElectronWindow.ts";
import * as DesktopWindow from "../../src/window/DesktopWindow.ts";

const decodeBootstrapEnvelope = Schema.decodeUnknownSync(ServerBootstrapEnvelope);

const backendConfig: DesktopBackendStartConfig = {
  executablePath: "/usr/local/bin/node",
  args: ["/app/apps/server/dist/bin.mjs", "start", "--bootstrap-fd", "3"],
  entryPath: "/app/apps/server/dist/bin.mjs",
  cwd: "/app",
  env: {},
  bootstrapEnvelope: decodeBootstrapEnvelope({ desktopBootstrapToken: "test-token" }),
  port: 3773,
  bootstrapToken: "test-token",
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
};

function makeFakeBrowserWindow() {
  const windowListeners = new Map<string, (...args: readonly unknown[]) => void>();
  const webContentsListeners = new Map<string, (...args: readonly unknown[]) => void>();
  const loadedUrls: string[] = [];

  const webContents = {
    getURL: () => loadedUrls.at(-1) ?? "",
    on: (eventName: string, listener: (...args: readonly unknown[]) => void) => {
      webContentsListeners.set(eventName, listener);
    },
    send: () => undefined,
    setWindowOpenHandler: () => undefined,
    session: {
      webRequest: {
        onHeadersReceived: () => undefined,
      },
    },
  };

  const window = {
    isDestroyed: () => false,
    loadURL: (url: string) => {
      loadedUrls.push(url);
      return Promise.resolve();
    },
    on: (eventName: string, listener: (...args: readonly unknown[]) => void) => {
      windowListeners.set(eventName, listener);
    },
    once: () => undefined,
    setTitle: () => undefined,
    webContents,
  };

  return {
    window: window as unknown as Electron.BrowserWindow,
    loadedUrls,
    webContentsListeners,
    windowListeners,
  };
}

const desktopEnvironmentLayer = Layer.effect(
  DesktopEnvironment.DesktopEnvironment,
  Effect.map(Path.Path, (path) =>
    DesktopEnvironment.makeWith(
      {
        dirname: "/app/apps/desktop/dist-electron",
        homeDirectory: "/home/user",
        platform: "darwin",
        appVersion: "0.0.0",
        appPath: "/app",
        isPackaged: false,
        resourcesPath: "/app/resources",
        appDataDirectory: Option.none(),
        xdgConfigHome: Option.none(),
        serverEntryOverride: Option.none(),
        configuredBackendPort: Option.none(),
        devServerUrl: Option.none(),
      },
      path,
    ),
  ),
).pipe(Layer.provide(Path.layer));

const electronMenuLayer = Layer.succeed(ElectronMenu.ElectronMenu, {
  showContextMenu: () => Effect.succeed(Option.none()),
  setApplicationMenu: () => Effect.void,
} satisfies ElectronMenu.ElectronMenu["Service"]);

const electronThemeLayer = Layer.succeed(ElectronTheme.ElectronTheme, {
  shouldUseDarkColors: Effect.succeed(false),
  setSource: () => Effect.void,
} satisfies ElectronTheme.ElectronTheme["Service"]);

function makeTestLayer(input: {
  readonly window: Electron.BrowserWindow;
  readonly createCount: Ref.Ref<number>;
  readonly mainWindow: Ref.Ref<Option.Option<Electron.BrowserWindow>>;
  readonly openedExternalUrls?: unknown[];
}) {
  const electronWindowLayer = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Ref.update(input.createCount, (count) => count + 1).pipe(Effect.as(input.window)),
    loadUrl: () => Effect.void,
    currentMainOrFirst: Ref.get(input.mainWindow),
    focusedMainOrFirst: Ref.get(input.mainWindow),
    setMain: (window) => Ref.set(input.mainWindow, Option.some(window)),
    clearMain: () => Ref.set(input.mainWindow, Option.none()),
    reveal: () => Effect.void,
    send: () => Effect.void,
    sendAll: () => Effect.void,
    onReadyToShow: () => Effect.void,
    onClosed: () => Effect.void,
    setWindowOpenHandler: () => Effect.void,
  } satisfies ElectronWindow.ElectronWindow["Service"]);

  return DesktopWindow.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        desktopEnvironmentLayer,
        electronMenuLayer,
        Layer.succeed(ElectronShell.ElectronShell, {
          openExternal: (url) =>
            Effect.sync(() => {
              input.openedExternalUrls?.push(url);
              return true;
            }),
        } satisfies ElectronShell.ElectronShell["Service"]),
        electronThemeLayer,
        electronWindowLayer,
      ),
    ),
  );
}

describe("DesktopWindow", () => {
  it("recognizes only same-origin renderer navigations", () => {
    assert.isTrue(
      DesktopWindow.isSameOriginRendererNavigation({
        applicationUrl: "app://app/",
        navigationUrl: "app://app/settings/connections",
      }),
    );
    assert.isFalse(
      DesktopWindow.isSameOriginRendererNavigation({
        applicationUrl: "app://app/",
        navigationUrl: "https://accounts.microsoft.com/oauth",
      }),
    );
    assert.isFalse(
      DesktopWindow.isSameOriginRendererNavigation({
        applicationUrl: "app://app/",
        navigationUrl: "not a url",
      }),
    );
  });

  it("retries only transient failures for the development renderer", () => {
    assert.isTrue(
      DesktopWindow.isRetryableDevelopmentRendererLoadFailure({
        applicationUrl: "app-dev://app/",
        errorCode: -102,
        isMainFrame: true,
        validatedUrl: "app-dev://app/",
      }),
    );
    assert.isFalse(
      DesktopWindow.isRetryableDevelopmentRendererLoadFailure({
        applicationUrl: "app-dev://app/",
        errorCode: -3,
        isMainFrame: true,
        validatedUrl: "app-dev://app/",
      }),
    );
    assert.isFalse(
      DesktopWindow.isRetryableDevelopmentRendererLoadFailure({
        applicationUrl: "app-dev://app/",
        errorCode: -102,
        isMainFrame: true,
        validatedUrl: "https://example.com/",
      }),
    );
  });

  it.effect("opens safe off-origin renderer navigations in the system browser", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const openedExternalUrls: unknown[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        openedExternalUrls,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(backendConfig);

        const willNavigate = fakeWindow.webContentsListeners.get("will-navigate");
        if (!willNavigate) {
          return yield* Effect.die("will-navigate listener was not registered");
        }
        let prevented = false;
        willNavigate(
          {
            preventDefault: () => {
              prevented = true;
            },
          },
          "https://accounts.microsoft.com/oauth",
        );
        yield* Effect.promise(() => Promise.resolve());

        assert.isTrue(prevented);
        assert.deepEqual(openedExternalUrls, ["https://accounts.microsoft.com/oauth"]);
      }).pipe(Effect.provide(layer));
    }),
  );
});
