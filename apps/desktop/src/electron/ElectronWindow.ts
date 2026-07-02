import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import { HostProcessPlatform } from "@app/shared/hostProcess";

// ── Tier-1 Electron wrapper for BrowserWindow ──
// The `create` diagnostic schema mirrors only the fields we actually pass, so a
// failed construction produces a structured, serializable error instead of a
// raw Electron throw.

const ElectronWindowCreateOptions = Schema.Struct({
  title: Schema.NullOr(Schema.String),
  width: Schema.NullOr(Schema.Number),
  height: Schema.NullOr(Schema.Number),
  show: Schema.NullOr(Schema.Boolean),
  backgroundColor: Schema.NullOr(Schema.String),
  webPreferences: Schema.Struct({
    preload: Schema.NullOr(Schema.String),
    sandbox: Schema.NullOr(Schema.Boolean),
    contextIsolation: Schema.NullOr(Schema.Boolean),
    nodeIntegration: Schema.NullOr(Schema.Boolean),
  }),
});

const ElectronWindowOperation = Schema.Literals([
  "list-windows",
  "get-focused-window",
  "inspect-window",
  "reveal-window",
  "load-url",
  "send-window-message",
  "add-window-listener",
  "set-open-handler",
]);

export class ElectronWindowCreateError extends Schema.TaggedErrorClass<ElectronWindowCreateError>()(
  "ElectronWindowCreateError",
  {
    options: ElectronWindowCreateOptions,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const title = this.options.title === null ? "" : ` "${this.options.title}"`;
    return `Failed to create Electron BrowserWindow${title}.`;
  }
}

export class ElectronWindowOperationError extends Schema.TaggedErrorClass<ElectronWindowOperationError>()(
  "ElectronWindowOperationError",
  {
    operation: ElectronWindowOperation,
    platform: Schema.String,
    windowId: Schema.NullOr(Schema.Number),
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const window = this.windowId === null ? "" : ` for window ${this.windowId}`;
    return `Electron window operation ${JSON.stringify(this.operation)} failed${window} on ${this.platform}.`;
  }
}

export class ElectronWindowLoadUrlError extends Schema.TaggedErrorClass<ElectronWindowLoadUrlError>()(
  "ElectronWindowLoadUrlError",
  {
    url: Schema.String,
    windowId: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to load ${this.url} in window ${this.windowId}.`;
  }
}

export class ElectronWindow extends Context.Service<
  ElectronWindow,
  {
    readonly create: (
      options: Electron.BrowserWindowConstructorOptions,
    ) => Effect.Effect<Electron.BrowserWindow, ElectronWindowCreateError>;
    readonly loadUrl: (
      window: Electron.BrowserWindow,
      url: string,
    ) => Effect.Effect<void, ElectronWindowLoadUrlError>;
    readonly currentMainOrFirst: Effect.Effect<Option.Option<Electron.BrowserWindow>>;
    readonly focusedMainOrFirst: Effect.Effect<Option.Option<Electron.BrowserWindow>>;
    readonly setMain: (window: Electron.BrowserWindow) => Effect.Effect<void>;
    readonly clearMain: (window: Option.Option<Electron.BrowserWindow>) => Effect.Effect<void>;
    readonly reveal: (window: Electron.BrowserWindow) => Effect.Effect<void>;
    readonly send: (
      window: Electron.BrowserWindow,
      channel: string,
      ...args: readonly unknown[]
    ) => Effect.Effect<void>;
    readonly sendAll: (channel: string, ...args: readonly unknown[]) => Effect.Effect<void>;
    /** Register a one-shot `ready-to-show` listener (fires when first painted). */
    readonly onReadyToShow: (
      window: Electron.BrowserWindow,
      handler: () => void,
    ) => Effect.Effect<void>;
    /** Register a `closed` listener (fires once the window is gone). */
    readonly onClosed: (window: Electron.BrowserWindow, handler: () => void) => Effect.Effect<void>;
    /** Decide what happens when the page tries to open a new window. */
    readonly setWindowOpenHandler: (
      window: Electron.BrowserWindow,
      handler: Parameters<Electron.WebContents["setWindowOpenHandler"]>[0],
    ) => Effect.Effect<void>;
  }
>()("@app/desktop/electron/ElectronWindow") {}

export const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  const mainWindowRef = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());

  const listWindows = Effect.try({
    try: () => Electron.BrowserWindow.getAllWindows(),
    catch: (cause) =>
      new ElectronWindowOperationError({
        operation: "list-windows",
        platform,
        windowId: null,
        channel: null,
        cause,
      }),
  }).pipe(Effect.orDie);

  const isWindowDestroyed = (window: Electron.BrowserWindow) =>
    Effect.try({
      try: () => window.isDestroyed(),
      catch: (cause) =>
        new ElectronWindowOperationError({
          operation: "inspect-window",
          platform,
          windowId: window.id,
          channel: null,
          cause,
        }),
    }).pipe(Effect.orDie);

  const liveMain = Effect.gen(function* () {
    const main = yield* Ref.get(mainWindowRef);
    if (Option.isNone(main) || (yield* isWindowDestroyed(main.value))) {
      return Option.none<Electron.BrowserWindow>();
    }
    return main;
  });

  const currentMainOrFirst = Effect.gen(function* () {
    const main = yield* liveMain;
    if (Option.isSome(main)) {
      return main;
    }
    const first = Option.fromNullishOr((yield* listWindows)[0] ?? null);
    if (Option.isNone(first) || (yield* isWindowDestroyed(first.value))) {
      return Option.none<Electron.BrowserWindow>();
    }
    return first;
  });

  const focusedMainOrFirst = Effect.gen(function* () {
    const focused = yield* Effect.try({
      try: () => Option.fromNullishOr(Electron.BrowserWindow.getFocusedWindow() ?? null),
      catch: (cause) =>
        new ElectronWindowOperationError({
          operation: "get-focused-window",
          platform,
          windowId: null,
          channel: null,
          cause,
        }),
    }).pipe(Effect.orDie);
    if (Option.isSome(focused) && !(yield* isWindowDestroyed(focused.value))) {
      return focused;
    }
    return yield* currentMainOrFirst;
  });

  return ElectronWindow.of({
    create: (options) => {
      const webPreferences = options.webPreferences;
      const diagnosticOptions = {
        title: options.title ?? null,
        width: options.width ?? null,
        height: options.height ?? null,
        show: options.show ?? null,
        backgroundColor: options.backgroundColor ?? null,
        webPreferences: {
          preload: webPreferences?.preload ?? null,
          sandbox: webPreferences?.sandbox ?? null,
          contextIsolation: webPreferences?.contextIsolation ?? null,
          nodeIntegration: webPreferences?.nodeIntegration ?? null,
        },
      } satisfies typeof ElectronWindowCreateOptions.Type;

      return Effect.try({
        try: () => new Electron.BrowserWindow(options),
        catch: (cause) => new ElectronWindowCreateError({ options: diagnosticOptions, cause }),
      });
    },
    loadUrl: (window, url) =>
      Effect.tryPromise({
        try: () => window.loadURL(url),
        catch: (cause) => new ElectronWindowLoadUrlError({ url, windowId: window.id, cause }),
      }),
    currentMainOrFirst,
    focusedMainOrFirst,
    setMain: (window) => Ref.set(mainWindowRef, Option.some(window)),
    clearMain: (window) =>
      Ref.update(mainWindowRef, (current) => {
        if (Option.isNone(current)) {
          return current;
        }
        if (Option.isSome(window) && current.value !== window.value) {
          return current;
        }
        return Option.none();
      }),
    reveal: (window) =>
      Effect.try({
        try: () => {
          if (window.isDestroyed()) {
            return;
          }
          if (window.isMinimized()) {
            window.restore();
          }
          if (!window.isVisible()) {
            window.show();
          }
          if (platform === "darwin") {
            Electron.app.focus({ steal: true });
          }
          window.focus();
        },
        catch: (cause) =>
          new ElectronWindowOperationError({
            operation: "reveal-window",
            platform,
            windowId: window.id,
            channel: null,
            cause,
          }),
      }).pipe(Effect.orDie),
    sendAll: (channel, ...args) =>
      Effect.gen(function* () {
        for (const window of yield* listWindows) {
          if (yield* isWindowDestroyed(window)) {
            continue;
          }
          yield* Effect.try({
            try: () => window.webContents.send(channel, ...args),
            catch: (cause) =>
              new ElectronWindowOperationError({
                operation: "send-window-message",
                platform,
                windowId: window.id,
                channel,
                cause,
              }),
          }).pipe(Effect.orDie);
        }
      }),
    send: (window, channel, ...args) =>
      Effect.try({
        try: () => {
          if (!window.isDestroyed()) {
            window.webContents.send(channel, ...args);
          }
        },
        catch: (cause) =>
          new ElectronWindowOperationError({
            operation: "send-window-message",
            platform,
            windowId: window.id,
            channel,
            cause,
          }),
      }).pipe(Effect.orDie),
    onReadyToShow: (window, handler) =>
      Effect.try({
        try: () => {
          window.once("ready-to-show", handler);
        },
        catch: (cause) =>
          new ElectronWindowOperationError({
            operation: "add-window-listener",
            platform,
            windowId: window.id,
            channel: null,
            cause,
          }),
      }).pipe(Effect.orDie),
    onClosed: (window, handler) =>
      Effect.try({
        try: () => {
          window.on("closed", handler);
        },
        catch: (cause) =>
          new ElectronWindowOperationError({
            operation: "add-window-listener",
            platform,
            windowId: window.id,
            channel: null,
            cause,
          }),
      }).pipe(Effect.orDie),
    setWindowOpenHandler: (window, handler) =>
      Effect.try({
        try: () => {
          window.webContents.setWindowOpenHandler(handler);
        },
        catch: (cause) =>
          new ElectronWindowOperationError({
            operation: "set-open-handler",
            platform,
            windowId: window.id,
            channel: null,
            cause,
          }),
      }).pipe(Effect.orDie),
  });
});

export const layer = Layer.effect(ElectronWindow, make);
