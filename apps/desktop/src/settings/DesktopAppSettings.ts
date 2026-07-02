import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { DesktopTheme, DesktopUpdateChannel } from "@app/contracts";
import { writeFileStringAtomically } from "@app/shared/atomicWrite";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

// Schema-validated, atomically-persisted settings store. Every field is
// optional on disk (so an old settings file with missing keys still decodes)
// and normalized back to defaults on load. Writes go through a temp-sibling +
// rename so a crash mid-write can't corrupt the file.

export interface DesktopSettings {
  readonly theme: DesktopTheme;
  readonly updateChannel: DesktopUpdateChannel;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  theme: "system",
  updateChannel: "latest",
};

const DesktopSettingsDocument = Schema.Struct({
  theme: Schema.optionalKey(DesktopTheme),
  updateChannel: Schema.optionalKey(DesktopUpdateChannel),
});
type DesktopSettingsDocument = typeof DesktopSettingsDocument.Type;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const DesktopSettingsJson = Schema.fromJsonString(DesktopSettingsDocument);
const decodeDesktopSettingsJson = Schema.decodeUnknownEffect(DesktopSettingsJson);
const encodeDesktopSettingsJson = Schema.encodeUnknownEffect(DesktopSettingsJson);

export interface DesktopSettingsChange {
  readonly settings: DesktopSettings;
  readonly changed: boolean;
}

const settingsChange = (settings: DesktopSettings, changed: boolean): DesktopSettingsChange => ({
  settings,
  changed,
});

export class DesktopSettingsWriteError extends Schema.TaggedErrorClass<DesktopSettingsWriteError>()(
  "DesktopSettingsWriteError",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist desktop settings at ${this.path}.`;
  }
}

export class DesktopAppSettings extends Context.Service<
  DesktopAppSettings,
  {
    readonly load: Effect.Effect<DesktopSettings>;
    readonly get: Effect.Effect<DesktopSettings>;
    readonly setTheme: (
      theme: DesktopTheme,
    ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
    readonly setUpdateChannel: (
      channel: DesktopUpdateChannel,
    ) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
  }
>()("@app/desktop/settings/DesktopAppSettings") {}

function normalizeDocument(parsed: DesktopSettingsDocument): DesktopSettings {
  return {
    theme: parsed.theme ?? DEFAULT_DESKTOP_SETTINGS.theme,
    updateChannel: parsed.updateChannel ?? DEFAULT_DESKTOP_SETTINGS.updateChannel,
  };
}

// Only write the fields that diverge from defaults, so a settings file stays
// minimal and forward-compatible with new default values.
function toDocument(settings: DesktopSettings, defaults: DesktopSettings): DesktopSettingsDocument {
  const document: Mutable<DesktopSettingsDocument> = {};
  if (settings.theme !== defaults.theme) document.theme = settings.theme;
  if (settings.updateChannel !== defaults.updateChannel) {
    document.updateChannel = settings.updateChannel;
  }
  return document;
}

function setTheme(settings: DesktopSettings, theme: DesktopTheme): DesktopSettings {
  return settings.theme === theme ? settings : { ...settings, theme };
}

function setUpdateChannel(
  settings: DesktopSettings,
  updateChannel: DesktopUpdateChannel,
): DesktopSettings {
  return settings.updateChannel === updateChannel ? settings : { ...settings, updateChannel };
}

function readSettings(
  fileSystem: FileSystem.FileSystem,
  settingsPath: string,
): Effect.Effect<DesktopSettings> {
  return fileSystem.readFileString(settingsPath).pipe(
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(DEFAULT_DESKTOP_SETTINGS),
        onSome: (raw) =>
          decodeDesktopSettingsJson(raw).pipe(
            Effect.map(normalizeDocument),
            Effect.orElseSucceed(() => DEFAULT_DESKTOP_SETTINGS),
          ),
      }),
    ),
  );
}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settingsRef = yield* SynchronizedRef.make(environment.defaultDesktopSettings);

  const persist = (
    update: (settings: DesktopSettings) => DesktopSettings,
  ): Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError> =>
    SynchronizedRef.modifyEffect(settingsRef, (settings) => {
      const nextSettings = update(settings);
      if (nextSettings === settings) {
        return Effect.succeed([settingsChange(settings, false), settings] as const);
      }
      return Effect.gen(function* () {
        const contents = yield* encodeDesktopSettingsJson(
          toDocument(nextSettings, environment.defaultDesktopSettings),
        );
        yield* writeFileStringAtomically({
          filePath: environment.desktopSettingsPath,
          contents: `${contents}\n`,
        });
        return [settingsChange(nextSettings, true), nextSettings] as const;
      }).pipe(
        // Provide the closed-over platform services so the returned setter is
        // `R = never` — the layer-construction context isn't ambient when a
        // consumer calls `setTheme` later.
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (cause) =>
            new DesktopSettingsWriteError({
              path: environment.desktopSettingsPath,
              cause,
            }),
        ),
      );
    });

  return DesktopAppSettings.of({
    get: SynchronizedRef.get(settingsRef),
    load: Effect.gen(function* () {
      const settings = yield* readSettings(fileSystem, environment.desktopSettingsPath);
      return yield* SynchronizedRef.setAndGet(settingsRef, settings);
    }).pipe(Effect.withSpan("desktop.settings.load")),
    setTheme: (theme) =>
      persist((settings) => setTheme(settings, theme)).pipe(
        Effect.withSpan("desktop.settings.setTheme", { attributes: { theme } }),
      ),
    setUpdateChannel: (channel) =>
      persist((settings) => setUpdateChannel(settings, channel)).pipe(
        Effect.withSpan("desktop.settings.setUpdateChannel", {
          attributes: { channel },
        }),
      ),
  });
});

export const layer = Layer.effect(DesktopAppSettings, make);

// In-memory test layer: same setter semantics, no filesystem. Seed the initial
// settings to exercise a specific configuration.
export const layerTest = (initialSettings: DesktopSettings = DEFAULT_DESKTOP_SETTINGS) =>
  Layer.effect(
    DesktopAppSettings,
    Effect.gen(function* () {
      const settingsRef = yield* SynchronizedRef.make(initialSettings);
      const update = (f: (settings: DesktopSettings) => DesktopSettings) =>
        SynchronizedRef.modify(settingsRef, (settings) => {
          const nextSettings = f(settings);
          return [settingsChange(nextSettings, nextSettings !== settings), nextSettings] as const;
        });

      return DesktopAppSettings.of({
        get: SynchronizedRef.get(settingsRef),
        load: SynchronizedRef.get(settingsRef),
        setTheme: (theme) => update((settings) => setTheme(settings, theme)),
        setUpdateChannel: (channel) => update((settings) => setUpdateChannel(settings, channel)),
      });
    }),
  );
