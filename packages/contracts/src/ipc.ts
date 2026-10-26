import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

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
