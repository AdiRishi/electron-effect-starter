import * as Schema from "effect/Schema";

import { PortSchema, TrimmedNonEmptyString } from "./baseSchemas.ts";

// A supervisor must not restart a server refused by the state-directory owner.
export const SERVER_EXIT_CODE_STATE_DIR_OWNED = 78;

/** What the desktop shell hands the server it spawns, over a private file descriptor. */
export const DesktopBackendBootstrap = Schema.Struct({
  mode: Schema.Literal("desktop"),
  port: PortSchema,
  host: Schema.String,
  baseDir: TrimmedNonEmptyString,
  desktopBootstrapToken: TrimmedNonEmptyString,
});
export type DesktopBackendBootstrap = typeof DesktopBackendBootstrap.Type;
