import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../src/app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "../../src/settings/DesktopAppSettings.ts";
import { layerTestEnvironment } from "../support/environment.ts";

const DesktopSettingsPatch = Schema.Struct({
  mainWindowBounds: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        x: Schema.Number,
        y: Schema.Number,
        width: Schema.Number,
        height: Schema.Number,
      }),
    ),
  ),
  mainWindowMaximized: Schema.optionalKey(Schema.Boolean),
});

const decodeDesktopSettingsPatch = Schema.decodeEffect(Schema.fromJsonString(DesktopSettingsPatch));
const encodeDesktopSettingsPatch = Schema.encodeEffect(Schema.fromJsonString(DesktopSettingsPatch));

const withSettings = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | DesktopAppSettings.DesktopAppSettings
    | DesktopEnvironment.DesktopEnvironment
    | FileSystem.FileSystem
  >,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const stateDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "desktop-settings-test-",
    });

    return yield* effect.pipe(
      Effect.provide(
        DesktopAppSettings.layer.pipe(
          Layer.provideMerge(
            layerTestEnvironment({
              stateDir,
              desktopSettingsPath: path.join(stateDir, "desktop-settings.json"),
            }),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const writeSettingsFile = (contents: string) =>
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(environment.desktopSettingsPath, contents);
  });

describe("DesktopAppSettings", () => {
  it.effect("falls back to defaults when the settings file is malformed", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* writeSettingsFile("{not-json");

        assert.deepEqual(yield* settings.load, DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS);
      }),
    ),
  );

  it.effect("rejects window bounds that do not satisfy the domain schema", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;

        yield* writeSettingsFile(
          yield* encodeDesktopSettingsPatch({
            mainWindowBounds: { x: 10.5, y: 20, width: 639, height: 620 },
            mainWindowMaximized: true,
          }),
        );

        const loaded = yield* settings.load;
        assert.isNull(loaded.mainWindowBounds);
        assert.isFalse(loaded.mainWindowMaximized);
      }),
    ),
  );

  it.effect("persists sparse desktop settings documents", () =>
    withSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;

        yield* settings.setMainWindowBounds({ x: -1200, y: 40, width: 1440, height: 960 }, true);

        const persisted = yield* decodeDesktopSettingsPatch(
          yield* fileSystem.readFileString(environment.desktopSettingsPath),
        );

        assert.deepEqual(persisted, {
          mainWindowBounds: { x: -1200, y: 40, width: 1440, height: 960 },
          mainWindowMaximized: true,
        });
        assert.deepEqual(yield* settings.load, {
          mainWindowBounds: { x: -1200, y: 40, width: 1440, height: 960 },
          mainWindowMaximized: true,
        });
      }),
    ),
  );
});
