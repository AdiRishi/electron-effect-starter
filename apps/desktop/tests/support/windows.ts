// @effect-diagnostics effectFnOpportunity:off -- Test fakes are inline stubs, not traced functions.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ElectronTheme from "../../src/electron/ElectronTheme.ts";
import * as ElectronWindow from "../../src/electron/ElectronWindow.ts";
import * as DesktopWindow from "../../src/window/DesktopWindow.ts";

export const layerFakeDesktopWindow = (
  overrides: Partial<DesktopWindow.DesktopWindow["Service"]> = {},
) =>
  Layer.succeed(
    DesktopWindow.DesktopWindow,
    DesktopWindow.DesktopWindow.of({
      activate: Effect.void,
      handleBackendReady: () => Effect.void,
      handleBackendNotReady: Effect.void,
      flushMainWindowBounds: Effect.void,
      syncAppearance: Effect.void,
      ...overrides,
    }),
  );

export const layerFakeElectronWindow = (
  overrides: Partial<ElectronWindow.ElectronWindow["Service"]> = {},
) =>
  Layer.succeed(
    ElectronWindow.ElectronWindow,
    ElectronWindow.ElectronWindow.of({
      create: () => Effect.die("unexpected window creation"),
      main: Effect.succeedNone,
      setMain: () => Effect.void,
      clearMain: () => Effect.void,
      reveal: () => Effect.void,
      destroyAll: Effect.void,
      syncAllAppearance: () => Effect.void,
      ...overrides,
    }),
  );

export const layerFakeElectronTheme = (
  overrides: Partial<ElectronTheme.ElectronTheme["Service"]> = {},
) =>
  Layer.succeed(
    ElectronTheme.ElectronTheme,
    ElectronTheme.ElectronTheme.of({
      shouldUseDarkColors: Effect.succeed(false),
      onUpdated: () => Effect.void,
      ...overrides,
    }),
  );
