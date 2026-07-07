import * as Schema from "effect/Schema";

import { NonNegativeInt, Port, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Returned by the `server.getConfig` unary RPC. The client's first request
 * after opening the socket doubles as the initial-sync handshake, so this is
 * intentionally cheap and always-available.
 */
export const ServerConfig = Schema.Struct({
  appName: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  /** When the server process started — lets the client detect restarts. */
  startedAt: Schema.DateTimeUtc,
});
export type ServerConfig = typeof ServerConfig.Type;

/**
 * One-line JSON envelope handed from the desktop shell to the spawned local
 * server over an inherited fd. Keeping this in contracts means both processes
 * agree on the secret/port bootstrap shape without sharing runtime logic.
 */
export const ServerBootstrapEnvelope = Schema.Struct({
  desktopBootstrapToken: TrimmedNonEmptyString,
  port: Schema.optionalKey(Port),
});
export type ServerBootstrapEnvelope = typeof ServerBootstrapEnvelope.Type;

/**
 * Lifecycle phases the server publishes through its ordered push bus. This is
 * the canonical "server-initiated push" demo: subscribers get a replay of the
 * retained snapshot followed by the live stream, ordered by `sequence`.
 */
export const ServerLifecyclePhase = Schema.Literals(["starting", "ready", "draining"]);
export type ServerLifecyclePhase = typeof ServerLifecyclePhase.Type;

export const ServerLifecycleStreamEvent = Schema.Struct({
  sequence: NonNegativeInt,
  phase: ServerLifecyclePhase,
  at: Schema.DateTimeUtc,
});
export type ServerLifecycleStreamEvent = typeof ServerLifecycleStreamEvent.Type;

/**
 * Emitted by the `server.subscribeTicks` streaming RPC — a monotonically increasing
 * counter. The toy "server push" that proves the transport streams and that
 * the client re-attaches the subscription across reconnects.
 */
export const TickEvent = Schema.Struct({
  tick: NonNegativeInt,
  at: Schema.DateTimeUtc,
});
export type TickEvent = typeof TickEvent.Type;

/** Payload of the `echo` unary RPC — demonstrates a request carrying input. */
export const EchoInput = Schema.Struct({
  message: Schema.String,
});
export type EchoInput = typeof EchoInput.Type;

export const EchoResult = Schema.Struct({
  message: Schema.String,
  receivedAt: Schema.DateTimeUtc,
});
export type EchoResult = typeof EchoResult.Type;
