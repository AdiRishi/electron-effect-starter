import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import type * as Electron from "electron";

import * as DesktopEnvironment from "../../src/app/DesktopEnvironment.ts";
import * as DesktopState from "../../src/app/DesktopState.ts";
import * as ElectronMenu from "../../src/electron/ElectronMenu.ts";
import * as ElectronShell from "../../src/electron/ElectronShell.ts";
import * as DesktopWindow from "../../src/window/DesktopWindow.ts";
import { makeFakeBrowserWindow } from "../support/browserWindow.ts";
import { layerTestEnvironment } from "../support/environment.ts";
import { layerFakeElectronTheme, layerFakeElectronWindow } from "../support/windows.ts";

const backendUrl = new URL("http://127.0.0.1:3773");

const makeScenario = Effect.fn("makeScenario")(function* (
  input: {
    readonly environment?: Partial<DesktopEnvironment.DesktopEnvironment["Service"]>;
    readonly onWindowCreate?: Effect.Effect<void>;
  } = {},
) {
  const fake = makeFakeBrowserWindow();
  const createCount = yield* Ref.make(0);
  const mainWindow = yield* Ref.make(Option.none<Electron.BrowserWindow>());
  const openedExternalUrls: string[] = [];
  const copiedTexts: string[] = [];
  const popups: ElectronMenu.ElectronMenuTemplateInput[] = [];
  const revealed: Electron.BrowserWindow[] = [];

  const layer = DesktopWindow.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerTestEnvironment({
          isDevelopment: true,
          devServerUrl: Option.some(new URL("http://127.0.0.1:5733")),
          ...input.environment,
        }),
        DesktopState.layer,
        layerFakeElectronTheme(),
        layerFakeElectronWindow({
          create: () =>
            Ref.update(createCount, (count) => count + 1).pipe(
              Effect.andThen(input.onWindowCreate ?? Effect.void),
              Effect.as(fake.window),
            ),
          main: Ref.get(mainWindow),
          setMain: (window) => Ref.set(mainWindow, Option.some(window)),
          clearMain: () => Ref.set(mainWindow, Option.none()),
          reveal: (window) => Effect.sync(() => revealed.push(window)),
          destroyAll: Effect.sync(fake.destroy),
        }),
        Layer.succeed(
          ElectronMenu.ElectronMenu,
          ElectronMenu.ElectronMenu.of({
            setApplicationMenu: () => Effect.void,
            popupTemplate: (popup) => Effect.sync(() => popups.push(popup)),
          }),
        ),
        Layer.succeed(
          ElectronShell.ElectronShell,
          ElectronShell.ElectronShell.of({
            openExternal: (url) => Effect.sync(() => openedExternalUrls.push(url) > 0),
            copyText: (text) =>
              Effect.sync(() => {
                copiedTexts.push(text);
              }),
          }),
        ),
      ),
    ),
  );

  return {
    fake,
    layer,
    createCount,
    mainWindow,
    openedExternalUrls,
    copiedTexts,
    popups,
    revealed,
  };
});

const contextMenuParams = (
  overrides: Partial<Electron.ContextMenuParams>,
): Partial<Electron.ContextMenuParams> => ({
  misspelledWord: "",
  dictionarySuggestions: [],
  linkURL: "",
  editFlags: {
    canUndo: false,
    canRedo: false,
    canCut: true,
    canCopy: true,
    canPaste: false,
    canDelete: false,
    canSelectAll: true,
    canEditRichly: false,
  },
  ...overrides,
});

describe("DesktopWindow", () => {
  it.effect("opens safe off-origin renderer navigations in the system browser", () =>
    Effect.gen(function* () {
      const scenario = yield* makeScenario();

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(backendUrl);

        let prevented = false;

        scenario.fake.emitWebContents(
          "will-navigate",
          { preventDefault: () => (prevented = true) },
          "https://accounts.example.com/oauth",
        );
        yield* Effect.yieldNow;

        assert.isTrue(prevented);
        assert.deepEqual(scenario.openedExternalUrls, ["https://accounts.example.com/oauth"]);
      }).pipe(Effect.provide(scenario.layer));
    }),
  );

  it.effect("does not open the main window once quitting has started", () =>
    Effect.gen(function* () {
      const scenario = yield* makeScenario();

      yield* Effect.gen(function* () {
        const windows = yield* DesktopWindow.DesktopWindow;
        const state = yield* DesktopState.DesktopState;
        yield* Ref.set(state.quitting, true);

        yield* windows.handleBackendReady(backendUrl);
        yield* windows.activate;

        assert.equal(yield* Ref.get(scenario.createCount), 0);
        assert.isTrue(Option.isNone(yield* Ref.get(scenario.mainWindow)));
      }).pipe(Effect.provide(scenario.layer));
    }),
  );

  it.effect("destroys a main window when quit races native creation", () =>
    Effect.gen(function* () {
      const creationStarted = yield* Deferred.make<void>();
      const releaseCreation = yield* Deferred.make<void>();

      const scenario = yield* makeScenario({
        onWindowCreate: Deferred.succeed(creationStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseCreation)),
        ),
      });

      yield* Effect.gen(function* () {
        const windows = yield* DesktopWindow.DesktopWindow;
        const state = yield* DesktopState.DesktopState;

        const fiber = yield* windows
          .handleBackendReady(backendUrl)
          .pipe(Effect.forkChild({ startImmediately: true }));

        yield* Deferred.await(creationStarted);
        yield* Ref.set(state.quitting, true);
        yield* Deferred.succeed(releaseCreation, undefined);

        assert.isTrue(Exit.isSuccess(yield* Fiber.await(fiber)));
        assert.equal(yield* Ref.get(scenario.createCount), 1);
        assert.isTrue(scenario.fake.window.isDestroyed());
        assert.isTrue(Option.isNone(yield* Ref.get(scenario.mainWindow)));
        assert.deepEqual(scenario.fake.calls, []);
        assert.deepEqual(scenario.revealed, []);
      }).pipe(Effect.provide(scenario.layer));
    }),
  );

  it.effect("offers spelling fixes, link copying and the edit roles in the context menu", () =>
    Effect.gen(function* () {
      const scenario = yield* makeScenario();

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(backendUrl);

        scenario.fake.emitWebContents(
          "context-menu",
          { preventDefault: () => undefined },
          contextMenuParams({
            misspelledWord: "teh",
            dictionarySuggestions: ["the", "ten"],
            linkURL: "https://example.com/docs",
          }),
        );
        yield* Effect.yieldNow;

        const template = scenario.popups[0]?.template ?? [];

        assert.deepEqual(
          template.map((item) => item.label ?? item.role ?? item.type),
          [
            "the",
            "ten",
            "separator",
            "Copy Link",
            "separator",
            "cut",
            "copy",
            "paste",
            "selectAll",
          ],
        );
        assert.deepEqual(
          template.filter((item) => item.role !== undefined).map((item) => item.enabled),
          [true, true, false, true],
        );

        for (const label of ["the", "Copy Link"]) {
          // SAFETY: the context menu's click handlers ignore the menu item and event.
          template
            .find((item) => item.label === label)
            ?.click?.({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
        }

        yield* Effect.yieldNow;

        assert.include(scenario.fake.calls, "replaceMisspelling:the");
        assert.deepEqual(scenario.copiedTexts, ["https://example.com/docs"]);
      }).pipe(Effect.provide(scenario.layer));
    }),
  );

  it.effect("reveals a Linux window on its first load when ready-to-show never fires", () =>
    Effect.gen(function* () {
      const scenario = yield* makeScenario({ environment: { platform: "linux" } });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(backendUrl);

        scenario.fake.emitWebContentsOnce("did-finish-load");
        yield* Effect.yieldNow;
        assert.deepEqual(scenario.revealed, [scenario.fake.window]);

        scenario.fake.emitWindow("ready-to-show");
        yield* Effect.yieldNow;
        assert.deepEqual(scenario.revealed, [scenario.fake.window]);
      }).pipe(Effect.provide(scenario.layer));
    }),
  );

  it.effect("keeps one development reload pending however many loads fail", () =>
    Effect.gen(function* () {
      const scenario = yield* makeScenario();

      const failLoad = (url: string) =>
        scenario.fake.emitWebContents(
          "did-fail-load",
          {},
          -102,
          "ERR_CONNECTION_REFUSED",
          url,
          true,
        );

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(backendUrl);
        const loads = () => scenario.fake.calls.filter((call) => call.startsWith("loadURL")).length;
        const initialLoads = loads();

        failLoad("electron-effect-starter-dev://app/");
        failLoad("electron-effect-starter-dev://app/");
        failLoad("https://example.com/");
        yield* TestClock.adjust("2 seconds");

        assert.equal(loads() - initialLoads, 1);
      }).pipe(Effect.provide(scenario.layer));
    }),
  );
});
