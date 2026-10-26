import type { DesktopServerBootstrap } from "@app/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopLogger from "../app/DesktopLogger.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopBackendManager from "./DesktopBackendManager.ts";

const SERVER_HOST = "127.0.0.1";

// The server reads these from its environment ahead of the bootstrap envelope; the shell's
// values must not leak into the child it configures over fd 3.
const SCRUBBED_ENV_NAMES = [
  "APP_MODE",
  "APP_PORT",
  "APP_HOST",
  "APP_HOME",
  "APP_BOOTSTRAP_FD",
  "VITE_DEV_SERVER_URL",
] as const;

export class DesktopBackendPortMissingError extends Schema.TaggedError<DesktopBackendPortMissingError>()(
  "DesktopBackendPortMissingError",
  {},
) {
  override get message(): string {
    return "The server was asked to start before a port was chosen.";
  }
}

/** The one server this shell supervises, with the token that lets the renderer authenticate. */
export class DesktopBackend extends Context.Service<
  DesktopBackend,
  {
    readonly start: (port: number) => Effect.Effect<void>;
    /** Starts the server again on the port it last started with. */
    readonly restart: Effect.Effect<void>;
    readonly stop: (options?: { readonly timeout?: Duration.Duration }) => Effect.Effect<void>;
    readonly snapshot: Effect.Effect<DesktopBackendManager.DesktopBackendSnapshot>;
    readonly bootstrapToken: string;
    readonly rendererBootstrap: Effect.Effect<DesktopServerBootstrap | null>;
  }
>()("@app/desktop/backend/DesktopBackend") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const electronApp = yield* ElectronApp.ElectronApp;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;

  // One token per launch: a restarted server is re-seeded with it, so the renderer's bearer survives.
  const bootstrapToken = Buffer.from(yield* Effect.orDie(crypto.randomBytes(32))).toString(
    "base64url",
  );

  const port = yield* Ref.make(Option.none<number>());

  // The server logs only to stdout, so server.log is its record in a packaged build.
  const serverLog = yield* DesktopLogger.makeRotatingLogFileWriter({
    filePath: path.join(environment.logDir, "server.log"),
  });

  const failureLog = yield* DesktopLogger.makeBackendOutputLog({
    isDevelopment: environment.isDevelopment,
    logFile: yield* DesktopLogger.makeRotatingLogFileWriter({
      filePath: path.join(environment.logDir, "server-child.log"),
    }),
  });

  const configResolve = Effect.gen(function* () {
    const selectedPort = yield* Ref.get(port);

    if (Option.isNone(selectedPort)) return yield* Effect.die(new DesktopBackendPortMissingError());

    return {
      executablePath: process.execPath,
      entryPath: environment.backendEntryPath,
      args: [
        // Packaged builds keep their own compile cache; --require scopes it to the server process.
        ...(environment.isPackaged ? ["--require", environment.compileCachePath] : []),
        // node:sqlite is still flagged experimental and warns on every start.
        "--disable-warning=ExperimentalWarning",
        environment.backendEntryPath,
        "--bootstrap-fd",
        "3",
      ],
      cwd: environment.isPackaged ? environment.stateDir : environment.appRoot,
      env: {
        ...Object.fromEntries(SCRUBBED_ENV_NAMES.map((name) => [name, undefined])),
        ELECTRON_RUN_AS_NODE: "1",
      },
      bootstrap: {
        mode: "desktop" as const,
        port: selectedPort.value,
        host: SERVER_HOST,
        baseDir: environment.serverBaseDir,
        desktopBootstrapToken: bootstrapToken,
      },
      httpBaseUrl: new URL(`http://${SERVER_HOST}:${selectedPort.value}`),
    } satisfies DesktopBackendManager.DesktopBackendStartConfig;
  });

  const instance = yield* DesktopBackendManager.makeBackendInstance({
    configResolve,
    onReady: (httpBaseUrl) => desktopWindow.handleBackendReady(httpBaseUrl),
    onShutdown: () => desktopWindow.handleBackendNotReady,
    onStateDirOwned: () =>
      dialog
        .showErrorBox(
          `${environment.displayName} is already running`,
          "Another server is using this app's data directory. Quit the other copy and open the app again.",
        )
        .pipe(Effect.andThen(electronApp.quit)),
    outputLog: {
      ...failureLog,
      writeOutputChunk: (stream, chunk) =>
        serverLog
          .writeBytes(chunk)
          .pipe(Effect.andThen(failureLog.writeOutputChunk(stream, chunk))),
    },
  });

  const rendererBootstrap = instance.currentConfig.pipe(
    Effect.map((config) =>
      Option.match(config, {
        onNone: () => null,
        onSome: ({ httpBaseUrl }) => {
          const wsBaseUrl = new URL(httpBaseUrl);
          wsBaseUrl.protocol = "ws:";

          return { httpBaseUrl: httpBaseUrl.href, wsBaseUrl: wsBaseUrl.href };
        },
      }),
    ),
  );

  return DesktopBackend.of({
    start: Effect.fn("DesktopBackend.start")(function* (selectedPort: number) {
      yield* Ref.set(port, Option.some(selectedPort));
      yield* instance.start;
    }),
    restart: instance.start,
    stop: instance.stop,
    snapshot: instance.snapshot,
    bootstrapToken,
    rendererBootstrap,
  });
});

export const layer = Layer.effect(DesktopBackend, make);
