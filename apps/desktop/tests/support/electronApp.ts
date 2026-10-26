// @effect-diagnostics effectFnOpportunity:off -- Test fakes are inline stubs, not traced functions.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ElectronApp from "../../src/electron/ElectronApp.ts";

type AppEvents = ElectronApp.ElectronAppEvents;

/** Electron is the external seam: the fake app records listeners and the calls a test cares about. */
export const makeFakeElectronApp = (
  overrides: Partial<ElectronApp.ElectronApp["Service"]> = {},
) => {
  const listeners = new Map<string, (...args: never) => void>();

  const emit = <K extends keyof AppEvents>(eventName: K, ...args: AppEvents[K]) => {
    // SAFETY: `on` stores each listener under its own event name, so it accepts AppEvents[K].
    const listener = listeners.get(eventName) as ((...args: AppEvents[K]) => void) | undefined;
    listener?.(...args);
  };

  const emitBeforeQuitForUpdate = () => {
    // SAFETY: onBeforeQuitForUpdate stores a listener that takes no arguments.
    const listener = listeners.get("before-quit-for-update") as (() => void) | undefined;
    listener?.();
  };

  const register = (eventName: string, listener: (...args: never) => void) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        listeners.set(eventName, listener);
      }),
      () =>
        Effect.sync(() => {
          listeners.delete(eventName);
        }),
    ).pipe(Effect.asVoid);

  const service = ElectronApp.ElectronApp.of({
    metadata: Effect.die("unexpected metadata read"),
    whenReady: Effect.void,
    requestSingleInstanceLock: Effect.succeed(true),
    quit: Effect.void,
    exit: () => Effect.void,
    setPath: () => Effect.void,
    setAboutPanelOptions: () => Effect.void,
    setAppUserModelId: () => Effect.void,
    on: register,
    onBeforeQuitForUpdate: (listener) => register("before-quit-for-update", listener),
    ...overrides,
  });

  return {
    service,
    layer: Layer.succeed(ElectronApp.ElectronApp, service),
    emit,
    emitBeforeQuitForUpdate,
  };
};
