import * as NetService from "@app/shared/Net";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import * as DesktopBackend from "../backend/DesktopBackend.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import { installDesktopIpcHandlers } from "../ipc/DesktopIpcHandlers.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopApplicationMenu from "../window/DesktopApplicationMenu.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopLogger from "./DesktopLogger.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";

const DEFAULT_BACKEND_PORT = 3773;
const MAX_TCP_PORT = 65_535;
// A port is free only if nothing listens on it on any interface the server could share.
const BACKEND_PORT_PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::"] as const;

export class DesktopBackendPortUnavailableError extends Schema.TaggedError<DesktopBackendPortUnavailableError>()(
  "DesktopBackendPortUnavailableError",
  { startPort: Schema.Int },
) {
  override get message(): string {
    return `No port from ${this.startPort} upward is free for the local server.`;
  }
}

const { logInfo, logError } = DesktopLogger.forComponent("desktop-app");

const resolveBackendPort = Effect.fn("DesktopApp.resolveBackendPort")(function* (
  configuredPort: Option.Option<number>,
) {
  if (Option.isSome(configuredPort)) return configuredPort.value;
  const net = yield* NetService.NetService;
  // A stable port keeps the renderer's origin, and with it localStorage, the same across launches.
  for (let port = DEFAULT_BACKEND_PORT; port <= MAX_TCP_PORT; port += 1) {
    let available = true;
    for (const host of BACKEND_PORT_PROBE_HOSTS) {
      if (!(yield* net.canListenOnHost(port, host))) {
        available = false;
        break;
      }
    }
    if (available) return port;
  }
  return yield* new DesktopBackendPortUnavailableError({ startPort: DEFAULT_BACKEND_PORT });
});

const fatalStartupCause = Effect.fn("DesktopApp.fatalStartupCause")(function* <E>(
  stage: string,
  cause: Cause.Cause<E>,
) {
  const shutdown = yield* DesktopShutdown.DesktopShutdown;
  const state = yield* DesktopState.DesktopState;
  const electronApp = yield* ElectronApp.ElectronApp;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  yield* logError("fatal startup error", { stage }, cause);
  if (!(yield* Ref.getAndSet(state.quitting, true))) {
    yield* dialog.showErrorBox(
      `${environment.displayName} failed to start`,
      `Stage: ${stage}\n${Cause.pretty(cause)}`,
    );
  }
  yield* shutdown.request;
  yield* electronApp.quit;
  return yield* Effect.failCause(cause);
});

const bootstrap = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const state = yield* DesktopState.DesktopState;
  const protocol = yield* ElectronProtocol.ElectronProtocol;
  const backend = yield* DesktopBackend.DesktopBackend;

  yield* protocol.registerDesktopProtocol({
    scheme: ElectronProtocol.getDesktopScheme(environment.isDevelopment),
    ...(Option.isSome(environment.devServerUrl)
      ? { targetOrigin: environment.devServerUrl.value }
      : { assetDirectory: environment.clientAssetsDir }),
  });
  yield* installDesktopIpcHandlers();

  const port = yield* resolveBackendPort(environment.configuredBackendPort);
  yield* logInfo("starting the local server", { port });
  if (!(yield* Ref.get(state.quitting))) yield* backend.start(port);
}).pipe(Effect.withSpan("DesktopApp.bootstrap"));

const startup = Effect.gen(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
  const menu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
  const updates = yield* DesktopUpdates.DesktopUpdates;

  // A second launch hands focus to this one through "second-instance" and exits.
  if (!(yield* electronApp.requestSingleInstanceLock)) {
    yield* logInfo("another instance is running; exiting");
    yield* electronApp.quit;
    return yield* Effect.interrupt;
  }
  yield* lifecycle.register;
  yield* electronApp.whenReady.pipe(
    Effect.catchCause((cause) => fatalStartupCause("whenReady", cause)),
  );
  // Nothing the renderer loads needs camera, notifications or any other gated capability.
  Electron.session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  Electron.session.defaultSession.setPermissionCheckHandler(() => false);
  yield* menu.configure;
  yield* updates.configure;
  yield* bootstrap.pipe(Effect.catchCause((cause) => fatalStartupCause("bootstrap", cause)));
}).pipe(Effect.withSpan("DesktopApp.startup"));

/** The whole app lifetime is one scope; quitting completes the shutdown request. */
export const program = Effect.scoped(
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const runId = (yield* Effect.orDie(crypto.randomUUIDv4())).replaceAll("-", "").slice(0, 12);
    yield* Effect.annotateLogsScoped({ runId });

    const shutdown = yield* DesktopShutdown.DesktopShutdown;
    const backend = yield* DesktopBackend.DesktopBackend;
    // Quit can outrun layer finalizers; stop the server here so it gets SIGTERM before teardown.
    yield* Effect.addFinalizer(() =>
      backend.stop({ timeout: Duration.seconds(5) }).pipe(Effect.ensuring(shutdown.markComplete)),
    );

    yield* startup;
    yield* shutdown.awaitRequest;
  }),
).pipe(Effect.withSpan("DesktopApp"));
