import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import { DesktopTheme } from "@app/contracts";

export class ElectronThemeSetSourceError extends Schema.TaggedErrorClass<ElectronThemeSetSourceError>()(
  "ElectronThemeSetSourceError",
  {
    source: DesktopTheme,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to set the Electron theme source to ${this.source}.`;
  }
}

export class ElectronTheme extends Context.Service<
  ElectronTheme,
  {
    readonly shouldUseDarkColors: Effect.Effect<boolean>;
    readonly setSource: (
      theme: DesktopTheme,
    ) => Effect.Effect<void, ElectronThemeSetSourceError>;
  }
>()("@app/desktop/electron/ElectronTheme") {}

export const make = ElectronTheme.of({
  shouldUseDarkColors: Effect.sync(
    () => Electron.nativeTheme.shouldUseDarkColors,
  ),
  setSource: (theme) =>
    Effect.try({
      try: () => {
        Electron.nativeTheme.themeSource = theme;
      },
      catch: (cause) =>
        new ElectronThemeSetSourceError({ source: theme, cause }),
    }),
});

export const layer = Layer.succeed(ElectronTheme, make);
