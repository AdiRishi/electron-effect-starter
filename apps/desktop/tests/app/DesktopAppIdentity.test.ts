import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as Electron from "electron";

import * as DesktopAppIdentity from "../../src/app/DesktopAppIdentity.ts";
import { makeFakeElectronApp } from "../support/electronApp.ts";
import { layerTestEnvironment } from "../support/environment.ts";

const configure = (platform: NodeJS.Platform) => {
  const aboutPanels: Electron.AboutPanelOptionsOptions[] = [];
  const appUserModelIds: string[] = [];

  const layer = DesktopAppIdentity.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerTestEnvironment({
          platform,
          displayName: "Test (Dev)",
          appVersion: "1.2.3",
          appUserModelId: "com.example.test.dev",
        }),
        makeFakeElectronApp({
          setAboutPanelOptions: (options) => Effect.sync(() => aboutPanels.push(options)),
          setAppUserModelId: (id) => Effect.sync(() => appUserModelIds.push(id)),
        }).layer,
      ),
    ),
  );

  return Effect.gen(function* () {
    const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
    yield* identity.configure;

    return { aboutPanels, appUserModelIds };
  }).pipe(Effect.provide(layer));
};

describe("DesktopAppIdentity", () => {
  it.effect("names the app and its version in the About panel", () =>
    Effect.gen(function* () {
      const { aboutPanels } = yield* configure("darwin");

      assert.deepEqual(aboutPanels, [
        { applicationName: "Test (Dev)", applicationVersion: "1.2.3" },
      ]);
    }),
  );

  it.effect("sets the AppUserModelId on Windows only", () =>
    Effect.gen(function* () {
      assert.deepEqual((yield* configure("win32")).appUserModelIds, ["com.example.test.dev"]);
      assert.deepEqual((yield* configure("darwin")).appUserModelIds, []);
      assert.deepEqual((yield* configure("linux")).appUserModelIds, []);
    }),
  );
});
