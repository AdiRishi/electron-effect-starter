import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Custom URL schemes the desktop shell serves the renderer from; separate schemes keep dev and packaged storage apart. */
export const DESKTOP_SCHEME = "electron-effect-starter";
export const DESKTOP_DEV_SCHEME = "electron-effect-starter-dev";

export const DESKTOP_RENDERER_ORIGINS = [
  `${DESKTOP_SCHEME}://app`,
  `${DESKTOP_DEV_SCHEME}://app`,
] as const;

/** Where the renderer finds the server the desktop shell supervises. */
export const DesktopServerBootstrap = Schema.Struct({
  httpBaseUrl: TrimmedNonEmptyString,
  wsBaseUrl: TrimmedNonEmptyString,
});

export type DesktopServerBootstrap = typeof DesktopServerBootstrap.Type;

/**
 * Installed on `window.desktopBridge` by the preload script. Its absence means the web build is
 * running in a plain browser.
 */
export interface DesktopBridge {
  readonly getClientPlatform: () => string;
  readonly getServerBootstrap: () => DesktopServerBootstrap | null;
  readonly getBearerToken: () => Promise<string>;
  readonly openExternal: (url: string) => Promise<boolean>;
}
