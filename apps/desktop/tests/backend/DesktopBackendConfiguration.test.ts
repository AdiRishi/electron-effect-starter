import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as DesktopEnvironment from "../../src/app/DesktopEnvironment.ts";
import * as DesktopBackendConfiguration from "../../src/backend/DesktopBackendConfiguration.ts";

const desktopEnvironmentLayer = Layer.effect(
  DesktopEnvironment.DesktopEnvironment,
  Effect.map(Path.Path, (path) =>
    DesktopEnvironment.makeWith(
      {
        dirname: "/app/apps/desktop/dist-electron",
        homeDirectory: "/home/user",
        platform: "darwin",
        appVersion: "0.0.0",
        appPath: "/app",
        isPackaged: false,
        resourcesPath: "/app/resources",
        appDataDirectory: Option.none(),
        xdgConfigHome: Option.none(),
        serverEntryOverride: Option.some("/app/apps/server/dist/bin.mjs"),
        configuredBackendPort: Option.none(),
        devServerUrl: Option.none(),
      },
      path,
    ),
  ),
).pipe(Layer.provide(Path.layer));

const developmentEnvironmentLayer = Layer.effect(
  DesktopEnvironment.DesktopEnvironment,
  Effect.map(Path.Path, (path) =>
    DesktopEnvironment.makeWith(
      {
        dirname: "/app/apps/desktop/dist-electron",
        homeDirectory: "/home/user",
        platform: "darwin",
        appVersion: "0.0.0",
        appPath: "/app",
        isPackaged: false,
        resourcesPath: "/app/resources",
        appDataDirectory: Option.none(),
        xdgConfigHome: Option.none(),
        serverEntryOverride: Option.some("/app/apps/server/dist/bin.mjs"),
        configuredBackendPort: Option.none(),
        devServerUrl: Option.some(new URL("http://127.0.0.1:5733")),
      },
      path,
    ),
  ),
).pipe(Layer.provide(Path.layer));

const testLayer = DesktopBackendConfiguration.layer.pipe(
  Layer.provide(desktopEnvironmentLayer),
  Layer.provide(NodeServices.layer),
);

const developmentTestLayer = DesktopBackendConfiguration.layer.pipe(
  Layer.provide(developmentEnvironmentLayer),
  Layer.provide(NodeServices.layer),
);

describe("DesktopBackendConfiguration", () => {
  it.effect("resolves the packaged server from Electron's asar app path", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const environment = DesktopEnvironment.makeWith(
        {
          dirname: "/Applications/App.app/Contents/Resources/app.asar/apps/desktop/dist-electron",
          homeDirectory: "/home/user",
          platform: "darwin",
          appVersion: "0.0.0",
          appPath: "/Applications/App.app/Contents/Resources/app.asar",
          isPackaged: true,
          resourcesPath: "/Applications/App.app/Contents/Resources",
          appDataDirectory: Option.none(),
          xdgConfigHome: Option.none(),
          serverEntryOverride: Option.none(),
          configuredBackendPort: Option.none(),
          devServerUrl: Option.none(),
        },
        path,
      );

      assert.equal(
        environment.backendEntryPath,
        "/Applications/App.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs",
      );
      assert.equal(environment.backendCwd, "/home/user");
    }).pipe(Effect.provide(Path.layer)),
  );

  it.effect("resolves fd-based server bootstrap without putting the secret in env", () =>
    Effect.gen(function* () {
      const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;

      const config = yield* configuration.resolve({ port: 19731 });

      assert.deepEqual(config.args, [
        "/app/apps/server/dist/bin.mjs",
        "start",
        "--bootstrap-fd",
        "3",
      ]);
      assert.equal(config.env.ELECTRON_RUN_AS_NODE, "1");
      // Every server-read APP_* var is cleared so a developer shell cannot
      // override the envelope; the app-data base is re-provided explicitly.
      assert.isTrue("APP_BOOTSTRAP_TOKEN" in config.env);
      assert.equal(config.env.APP_BOOTSTRAP_TOKEN, undefined);
      assert.isTrue("APP_SERVER_PORT" in config.env);
      assert.equal(config.env.APP_SERVER_PORT, undefined);
      assert.isTrue("APP_SERVER_HOST" in config.env);
      assert.equal(config.env.APP_SERVER_HOST, undefined);
      assert.isTrue("APP_DEV_WEB_URL" in config.env);
      assert.equal(config.env.APP_DEV_WEB_URL, undefined);
      assert.equal(
        config.env.APP_DATA_DIR,
        "/home/user/Library/Application Support/electron-effect-starter",
      );
      assert.equal(config.bootstrapEnvelope.port, 19731);
      assert.equal(config.bootstrapEnvelope.desktopBootstrapToken, config.bootstrapToken);
      assert.match(config.bootstrapToken, /^[0-9a-f]{48}$/);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("re-provides the dev web URL to the child in development", () =>
    Effect.gen(function* () {
      const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;

      const config = yield* configuration.resolve({ port: 19731 });

      assert.equal(config.env.APP_DEV_WEB_URL, "http://127.0.0.1:5733/");
      assert.equal(config.env.APP_SERVER_HOST, undefined);
    }).pipe(Effect.provide(developmentTestLayer)),
  );
});
