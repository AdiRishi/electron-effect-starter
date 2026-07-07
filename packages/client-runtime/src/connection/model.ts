import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * The single transient error the client transport surfaces. A dropped socket, a
 * failed open, or a failed credential mint all collapse to this; the supervisor
 * treats it as "retry after backoff". Kept deliberately small — a starter has
 * one failure mode.
 */
export class ConnectionTransientError extends Schema.TaggedErrorClass<ConnectionTransientError>()(
  "ConnectionTransientError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * Everything the supervisor needs to open one socket: a human label for
 * diagnostics plus `prepareSocketUrl`, an effect that mints a fresh bearer
 * credential and returns the fully-formed `/ws` URL. The supervisor runs it at
 * the top of EVERY connect attempt, so a failed credential mint is just another
 * transient failure it backs off from and retries — the auth step lives inside
 * the reconnect loop, not above it. The supervisor stays transport-agnostic.
 */
export interface PreparedConnection {
  readonly label: string;
  readonly prepareSocketUrl: Effect.Effect<string, ConnectionTransientError>;
}

/**
 * The coarse connection phase the UI renders. `connecting` covers the very first
 * attempt; once we have been connected at least once, subsequent attempts show
 * as `reconnecting` so the status dot can distinguish a cold start from a blip.
 */
export type ConnectionPhase = "idle" | "connecting" | "connected" | "reconnecting";

export interface ConnectionState {
  readonly phase: ConnectionPhase;
  /** Failed attempts since the last *stable* connection (30s+ uptime). */
  readonly attempt: number;
  /** Detail of the most recent failure, or null while healthy. */
  readonly lastError: string | null;
}

export const INITIAL_CONNECTION_STATE: ConnectionState = Object.freeze({
  phase: "idle",
  attempt: 0,
  lastError: null,
});
