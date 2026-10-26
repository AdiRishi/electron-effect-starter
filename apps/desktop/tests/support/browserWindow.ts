import type * as Electron from "electron";

type Listener = (...args: ReadonlyArray<never>) => void;

/** A BrowserWindow that records listeners and calls; tests drive Electron's events by hand. */
export function makeFakeBrowserWindow() {
  const windowListeners = new Map<string, Listener>();
  const webContentsListeners = new Map<string, Listener>();
  const webContentsOnceListeners = new Map<string, Listener>();
  const calls: string[] = [];
  let destroyed = false;
  let url = "electron-effect-starter-dev://app/";

  const record =
    (name: string) =>
    (..._args: ReadonlyArray<unknown>) => {
      calls.push(name);
    };

  const webContents = {
    on: (eventName: string, listener: Listener) => {
      webContentsListeners.set(eventName, listener);
    },
    once: (eventName: string, listener: Listener) => {
      webContentsOnceListeners.set(eventName, listener);
    },
    getURL: () => url,
    openDevTools: record("openDevTools"),
    replaceMisspelling: (suggestion: string) => calls.push(`replaceMisspelling:${suggestion}`),
    setBackgroundThrottling: record("setBackgroundThrottling"),
    setWindowOpenHandler: record("setWindowOpenHandler"),
  };

  const fake = {
    id: 1,
    webContents,
    isDestroyed: () => destroyed,
    loadURL: (loadedUrl: string) => {
      calls.push(`loadURL:${loadedUrl}`);

      return Promise.resolve();
    },
    on: (eventName: string, listener: Listener) => {
      windowListeners.set(eventName, listener);
    },
    once: (eventName: string, listener: Listener) => {
      windowListeners.set(eventName, listener);
    },
    setBackgroundColor: (color: string) => calls.push(`setBackgroundColor:${color}`),
  };

  const emit = (
    listeners: Map<string, Listener>,
    eventName: string,
    args: ReadonlyArray<unknown>,
  ) => {
    // SAFETY: tests pass the arguments Electron sends for this event.
    const listener = listeners.get(eventName) as
      | ((...args: ReadonlyArray<unknown>) => void)
      | undefined;

    listener?.(...args);
  };

  return {
    // SAFETY: DesktopWindow uses only the members above.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The fake implements only the members DesktopWindow calls.
    window: fake as unknown as Electron.BrowserWindow,
    calls,
    destroy: () => {
      destroyed = true;
    },
    setUrl: (nextUrl: string) => {
      url = nextUrl;
    },
    emitWindow: (eventName: string, ...args: ReadonlyArray<unknown>) =>
      emit(windowListeners, eventName, args),
    emitWebContents: (eventName: string, ...args: ReadonlyArray<unknown>) =>
      emit(webContentsListeners, eventName, args),
    emitWebContentsOnce: (eventName: string, ...args: ReadonlyArray<unknown>) =>
      emit(webContentsOnceListeners, eventName, args),
  };
}
