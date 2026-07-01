import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

// ── Tier-1 Electron wrapper ──
// Every raw `Electron.app` call is wrapped in `Effect.try`/`Effect.tryPromise`
// producing a `Schema.TaggedErrorClass`. `Desktop*` services depend on this
// wrapper and never touch `electron` directly, which is what keeps the shell's
// logic testable.

export interface ElectronAppMetadata {
  readonly appVersion: string;
  readonly appPath: string;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
}

export class ElectronAppMetadataReadError extends Schema.TaggedErrorClass<ElectronAppMetadataReadError>()(
  "ElectronAppMetadataReadError",
  {
    property: Schema.Literals(["app-version", "app-path"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read Electron app metadata property "${this.property}".`;
  }
}

export class ElectronAppWhenReadyError extends Schema.TaggedErrorClass<ElectronAppWhenReadyError>()(
  "ElectronAppWhenReadyError",
  {
    isPackaged: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to wait for the Electron app to become ready (packaged: ${this.isPackaged}).`;
  }
}

export class ElectronApp extends Context.Service<
  ElectronApp,
  {
    readonly metadata: Effect.Effect<ElectronAppMetadata, ElectronAppMetadataReadError>;
    readonly name: Effect.Effect<string>;
    readonly whenReady: Effect.Effect<void, ElectronAppWhenReadyError>;
    readonly quit: Effect.Effect<void>;
    readonly exit: (code: number) => Effect.Effect<void>;
    readonly setPath: (
      name: Parameters<Electron.App["setPath"]>[0],
      path: string,
    ) => Effect.Effect<void>;
    readonly setName: (name: string) => Effect.Effect<void>;
    readonly requestSingleInstanceLock: Effect.Effect<boolean>;
    readonly on: <Args extends ReadonlyArray<unknown>>(
      eventName: string,
      listener: (...args: Args) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@app/desktop/electron/ElectronApp") {}

const addScopedAppListener = <Args extends ReadonlyArray<unknown>>(
  eventName: string,
  listener: (...args: Args) => void,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      Electron.app.on(eventName as never, listener as never);
    }),
    () =>
      Effect.sync(() => {
        Electron.app.removeListener(eventName as never, listener as never);
      }),
  ).pipe(Effect.asVoid);

export const make = ElectronApp.of({
  metadata: Effect.gen(function* () {
    const appVersion = yield* Effect.try({
      try: () => Electron.app.getVersion(),
      catch: (cause) => new ElectronAppMetadataReadError({ property: "app-version", cause }),
    });
    const appPath = yield* Effect.try({
      try: () => Electron.app.getAppPath(),
      catch: (cause) => new ElectronAppMetadataReadError({ property: "app-path", cause }),
    });

    return {
      appVersion,
      appPath,
      isPackaged: Electron.app.isPackaged,
      resourcesPath: process.resourcesPath,
    };
  }),
  name: Effect.sync(() => Electron.app.name),
  whenReady: Effect.gen(function* () {
    const isPackaged = Electron.app.isPackaged;
    yield* Effect.tryPromise({
      try: () => Electron.app.whenReady(),
      catch: (cause) => new ElectronAppWhenReadyError({ isPackaged, cause }),
    });
  }),
  quit: Effect.sync(() => {
    Electron.app.quit();
  }),
  exit: (code) =>
    Effect.sync(() => {
      Electron.app.exit(code);
    }),
  setPath: (name, path) =>
    Effect.sync(() => {
      Electron.app.setPath(name, path);
    }),
  setName: (name) =>
    Effect.sync(() => {
      Electron.app.setName(name);
    }),
  requestSingleInstanceLock: Effect.sync(() => Electron.app.requestSingleInstanceLock()),
  on: addScopedAppListener,
});

export const layer = Layer.succeed(ElectronApp, make);
