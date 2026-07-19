import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const ConnectionBlockedReason = Schema.Literals([
  "authentication",
  "configuration",
  "permission",
]);
export type ConnectionBlockedReason = typeof ConnectionBlockedReason.Type;

/**
 * A failure the supervisor can recover from on its own. A dropped socket, a
 * failed open, or a network blip all collapse to this; the supervisor treats it
 * as "retry after backoff".
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
 * A failure retrying cannot fix: rejected credentials, missing permission, or
 * broken configuration. The supervisor parks instead of backing off — it stays
 * `blocked` until something outside the loop (changed credentials, an explicit
 * retry) requests another attempt.
 */
export class ConnectionBlockedError extends Schema.TaggedErrorClass<ConnectionBlockedError>()(
  "ConnectionBlockedError",
  {
    reason: ConnectionBlockedReason,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export type ConnectionAttemptError = ConnectionTransientError | ConnectionBlockedError;

/**
 * Everything the supervisor needs to open one socket: a human label for
 * diagnostics plus `prepareSocketUrl`, an effect that mints a fresh bearer
 * credential and returns the fully-formed `/ws` URL. The supervisor runs it at
 * the top of EVERY connect attempt, so a failed credential mint fails that
 * attempt — transient mints back off and retry, rejected credentials block —
 * the auth step lives inside the reconnect loop, not above it. The supervisor
 * stays transport-agnostic.
 */
export interface PreparedConnection {
  readonly label: string;
  readonly prepareSocketUrl: Effect.Effect<string, ConnectionAttemptError>;
}

/**
 * The coarse connection phase the UI renders. `connecting` covers the very first
 * attempt; once we have been connected at least once, subsequent attempts show
 * as `reconnecting` so the status dot can distinguish a cold start from a blip.
 * `blocked` means the last attempt failed in a way retrying cannot fix; the
 * supervisor is parked until `retryNow` (or changed credentials) wakes it.
 */
export type ConnectionPhase = "idle" | "connecting" | "connected" | "reconnecting" | "blocked";

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
