import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

/** How the OS names and groups the app: the About panel and, on Windows, the AppUserModelId. */
export class DesktopAppIdentity extends Context.Service<
  DesktopAppIdentity,
  { readonly configure: Effect.Effect<void> }
>()("@app/desktop/app/DesktopAppIdentity") {}

const make = Effect.gen(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;

  const configure = Effect.gen(function* () {
    yield* electronApp.setAboutPanelOptions({
      applicationName: environment.displayName,
      applicationVersion: environment.appVersion,
    });

    // Windows groups taskbar entries and attributes notifications by this id; it must match the
    // installer's shortcut, which electron-builder stamps with the appId.
    if (environment.platform === "win32") {
      yield* electronApp.setAppUserModelId(environment.appUserModelId);
    }
  }).pipe(Effect.withSpan("DesktopAppIdentity.configure"));

  return DesktopAppIdentity.of({ configure });
});

export const layer = Layer.effect(DesktopAppIdentity, make);
