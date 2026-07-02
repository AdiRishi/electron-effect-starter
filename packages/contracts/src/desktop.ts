import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DesktopTheme = Schema.Literals(["light", "dark", "system"]);
export type DesktopTheme = typeof DesktopTheme.Type;

export const DesktopUpdateChannel = Schema.Literals(["latest", "nightly"]);
export type DesktopUpdateChannel = typeof DesktopUpdateChannel.Type;

export const DesktopUpdateStatus = Schema.Literals([
  "disabled",
  "idle",
  "checking",
  "up-to-date",
  "available",
  "downloading",
  "downloaded",
  "error",
]);
export type DesktopUpdateStatus = typeof DesktopUpdateStatus.Type;

export const DesktopUpdateState = Schema.Struct({
  status: DesktopUpdateStatus,
  channel: DesktopUpdateChannel,
  version: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
});
export type DesktopUpdateState = typeof DesktopUpdateState.Type;

/** Static app identity the renderer reads synchronously at boot (branding). */
export const DesktopAppInfo = Schema.Struct({
  name: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  platform: Schema.Literals(["darwin", "win32", "linux"]),
  isPackaged: Schema.Boolean,
});
export type DesktopAppInfo = typeof DesktopAppInfo.Type;

/**
 * Where the local server lives + how to reach it, handed from shell to
 * renderer. In-shell the renderer is served same-origin, but it still needs to
 * know the ws URL and (separately, via `getBearerToken`) how to authenticate.
 */
export const DesktopServerBootstrap = Schema.Struct({
  httpBaseUrl: TrimmedNonEmptyString,
  wsBaseUrl: TrimmedNonEmptyString,
});
export type DesktopServerBootstrap = typeof DesktopServerBootstrap.Type;

export const PickFolderOptions = Schema.Struct({
  defaultPath: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
});
export type PickFolderOptions = typeof PickFolderOptions.Type;

export interface ContextMenuItem<T extends string = string> {
  readonly id: T;
  readonly label: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly children?: readonly ContextMenuItem<T>[];
}

// Recursive schemas need an explicit type annotation (`Schema.suspend` breaks
// inference), so the schema is typed by the interface's default instantiation.
// It keeps the `Schema` suffix because the interface owns the bare name.
export const ContextMenuItemSchema: Schema.Codec<ContextMenuItem> = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  destructive: Schema.optionalKey(Schema.Boolean),
  disabled: Schema.optionalKey(Schema.Boolean),
  children: Schema.optionalKey(
    Schema.Array(Schema.suspend((): Schema.Codec<ContextMenuItem> => ContextMenuItemSchema)),
  ),
});

export const ContextMenuPosition = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
});
export type ContextMenuPosition = typeof ContextMenuPosition.Type;
