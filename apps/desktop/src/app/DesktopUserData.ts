import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLogger from "./DesktopLogger.ts";

const { logInfo } = DesktopLogger.forComponent("desktop-user-data");

/**
 * Claims this launch's userData directory before anything else is built. Electron keys the
 * single-instance lock on userData, so the path is set first; a second launch then quits before any
 * later layer can open the running instance's files.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const electronApp = yield* ElectronApp.ElectronApp;
    yield* electronApp.setPath("userData", environment.userDataPath);

    // A second launch hands focus to the running one through "second-instance" and exits.
    if (!(yield* electronApp.requestSingleInstanceLock)) {
      yield* logInfo("another instance is running; exiting");
      yield* electronApp.quit;

      return yield* Effect.interrupt;
    }
  }),
);
