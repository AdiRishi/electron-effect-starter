import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** Only web and mail links leave the app; anything else could launch an arbitrary local handler. */
export function parseSafeExternalUrl(rawUrl: string): Option.Option<string> {
  try {
    const url = new URL(rawUrl);

    return SAFE_EXTERNAL_PROTOCOLS.has(url.protocol) ? Option.some(url.href) : Option.none();
  } catch {
    return Option.none();
  }
}

export class ElectronShell extends Context.Service<
  ElectronShell,
  {
    readonly openExternal: (rawUrl: string) => Effect.Effect<boolean>;
  }
>()("@app/desktop/electron/ElectronShell") {}

const make = ElectronShell.of({
  openExternal: Effect.fn("ElectronShell.openExternal")(function (rawUrl: string) {
    return Option.match(parseSafeExternalUrl(rawUrl), {
      onNone: () => Effect.succeed(false),
      onSome: (url) =>
        Effect.promise(() =>
          Electron.shell.openExternal(url).then(
            () => true,
            () => false,
          ),
        ),
    });
  }),
});

export const layer = Layer.succeed(ElectronShell, make);
