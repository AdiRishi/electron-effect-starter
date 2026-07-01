import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { installDesktopIpcHandlers } from "../ipc/DesktopIpcHandlers.ts";
import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopUpdater from "../updates/DesktopUpdater.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";

// The application program. It is `Effect.scoped`: `startup` brings the app up,
// then it blocks on `shutdown.awaitRequest`. When shutdown fires (all windows
// closed / before-quit), the scope closes and the finalizer stops the backend
// child. A fatal error during startup/bootstrap shows an error box and quits.

const { logInfo: logStartupInfo, logError: logStartupError } =
  makeComponentLogger("desktop-startup");
const { logInfo: logBootstrapInfo } = makeComponentLogger("desktop-bootstrap");

const makeRunId = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.map((value) => value.replaceAll("-", "").slice(0, 12)),
);

const handleFatalStartupError = Effect.fn("desktop.startup.handleFatalStartupError")(function* (
  stage: string,
  cause: Cause.Cause<unknown>,
) {
  const shutdown = yield* DesktopShutdown.DesktopShutdown;
  const state = yield* DesktopState.DesktopState;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const message = Cause.pretty(cause);
  yield* logStartupError("fatal startup error", { stage, message });
  const wasQuitting = yield* Ref.getAndSet(state.quitting, true);
  if (!wasQuitting) {
    yield* electronDialog.showErrorBox("App failed to start", `Stage: ${stage}\n${message}`);
  }
  yield* shutdown.request;
  yield* electronApp.quit;
});

const fatalStartupCause = (stage: string, cause: Cause.Cause<unknown>) =>
  handleFatalStartupError(stage, cause).pipe(Effect.andThen(Effect.failCause(cause)));

const bootstrap = Effect.gen(function* () {
  const manager = yield* DesktopBackendManager.DesktopBackendManager;
  const state = yield* DesktopState.DesktopState;
  yield* logBootstrapInfo("bootstrap start");

  yield* installDesktopIpcHandlers();
  yield* logBootstrapInfo("ipc handlers registered");

  if (!(yield* Ref.get(state.quitting))) {
    yield* manager.start;
    yield* logBootstrapInfo("backend start requested");
  }
}).pipe(Effect.withSpan("desktop.bootstrap"));

const startup = Effect.gen(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const updater = yield* DesktopUpdater.DesktopUpdater;
  const electronTheme = yield* ElectronTheme.ElectronTheme;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;

  const loaded = yield* settings.load;
  yield* electronTheme.setSource(loaded.theme).pipe(Effect.ignore({ log: true }));
  yield* logStartupInfo("settings loaded", { logDir: environment.logDir });

  yield* lifecycle.register;

  yield* electronApp.whenReady.pipe(
    Effect.withSpan("desktop.electron.whenReady"),
    Effect.catchCause((cause) => fatalStartupCause("whenReady", cause)),
  );
  yield* logStartupInfo("app ready");

  yield* electronApp.setPath("userData", environment.baseDir);
  yield* updater.configure;
  yield* bootstrap.pipe(Effect.catchCause((cause) => fatalStartupCause("bootstrap", cause)));
}).pipe(Effect.withSpan("desktop.startup"));

const scopedProgram = Effect.scoped(
  Effect.gen(function* () {
    const runId = yield* makeRunId;
    yield* Effect.annotateLogsScoped({ scope: "desktop", runId });
    yield* Effect.annotateCurrentSpan({ scope: "desktop", runId });

    const shutdown = yield* DesktopShutdown.DesktopShutdown;
    const manager = yield* DesktopBackendManager.DesktopBackendManager;

    yield* Effect.addFinalizer(() =>
      manager.stop().pipe(Effect.ensuring(shutdown.markComplete)),
    );

    yield* startup;
    yield* shutdown.awaitRequest;
  }),
);

export const program = scopedProgram.pipe(Effect.withSpan("desktop.app"));
