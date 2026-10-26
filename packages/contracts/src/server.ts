import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ServerPlatformOs = Schema.Literals(["darwin", "linux", "windows", "unknown"]);
export type ServerPlatformOs = typeof ServerPlatformOs.Type;

export const ServerPlatformArch = Schema.Literals(["arm64", "x64", "other"]);
export type ServerPlatformArch = typeof ServerPlatformArch.Type;

export const ServerDescriptor = Schema.Struct({
  name: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  platform: Schema.Struct({
    os: ServerPlatformOs,
    arch: ServerPlatformArch,
  }),
});
export type ServerDescriptor = typeof ServerDescriptor.Type;

export const ServerLifecycleWelcomeEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("welcome"),
  payload: Schema.Struct({ server: ServerDescriptor }),
});
export type ServerLifecycleWelcomeEvent = typeof ServerLifecycleWelcomeEvent.Type;

export const ServerLifecycleReadyEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("ready"),
  payload: Schema.Struct({ at: Schema.DateTimeUtc, server: ServerDescriptor }),
});
export type ServerLifecycleReadyEvent = typeof ServerLifecycleReadyEvent.Type;

export const ServerLifecycleEvent = Schema.Union([
  ServerLifecycleWelcomeEvent,
  ServerLifecycleReadyEvent,
]);
export type ServerLifecycleEvent = typeof ServerLifecycleEvent.Type;
