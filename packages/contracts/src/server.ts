import * as Schema from "effect/Schema";

/**
 * Returned by the `server.getConfig` unary RPC. The client's first request
 * after opening the socket doubles as the initial-sync handshake, so this is
 * intentionally cheap and always-available.
 */
export const ServerConfig = Schema.Struct({
  appName: Schema.String,
  version: Schema.String,
  /** Unix millis the server process started — lets the client detect restarts. */
  startedAt: Schema.Number,
});
export type ServerConfig = typeof ServerConfig.Type;

/**
 * Lifecycle phases the server publishes through its ordered push bus. This is
 * the canonical "server-initiated push" demo: subscribers get a replay of the
 * retained snapshot followed by the live stream, ordered by `sequence`.
 */
export const ServerLifecyclePhase = Schema.Literals(["starting", "ready", "draining"]);
export type ServerLifecyclePhase = typeof ServerLifecyclePhase.Type;

export const ServerLifecycleStreamEvent = Schema.Struct({
  sequence: Schema.Number,
  phase: ServerLifecyclePhase,
  at: Schema.Number,
});
export type ServerLifecycleStreamEvent = typeof ServerLifecycleStreamEvent.Type;

/**
 * Emitted by the `subscribeTicks` streaming RPC — a monotonically increasing
 * counter. The toy "server push" that proves the transport streams and that
 * the client re-attaches the subscription across reconnects.
 */
export const TickEvent = Schema.Struct({
  tick: Schema.Number,
  at: Schema.Number,
});
export type TickEvent = typeof TickEvent.Type;

/** Payload of the `echo` unary RPC — demonstrates a request carrying input. */
export const EchoInput = Schema.Struct({
  message: Schema.String,
});
export type EchoInput = typeof EchoInput.Type;

export const EchoResult = Schema.Struct({
  message: Schema.String,
  receivedAt: Schema.Number,
});
export type EchoResult = typeof EchoResult.Type;
