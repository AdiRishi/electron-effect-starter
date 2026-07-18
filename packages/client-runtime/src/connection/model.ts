import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * A transient connection failure. A dropped socket, a failed open, a timed-out
 * handshake, or a failed credential mint all collapse to this; the supervisor
 * treats it as "retry after backoff".
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
 * A failure retrying cannot fix: the server said "you are not allowed" (a
 * rejected credential) or the client is misconfigured. The supervisor parks in
 * the `blocked` phase instead of hammering the server — only an explicit
 * `retryNow` (or a network change) re-attempts, so the UI can surface "your
 * credential is bad" instead of an eternal "reconnecting…".
 */
export class ConnectionBlockedError extends Schema.TaggedErrorClass<ConnectionBlockedError>()(
  "ConnectionBlockedError",
  {
    reason: Schema.Literals(["authentication", "configuration"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Everything one connection attempt can fail with. */
export type ConnectionAttemptError = ConnectionTransientError | ConnectionBlockedError;

/**
 * Everything the supervisor needs to open one socket: a human label for
 * diagnostics plus `prepareSocketUrl`, an effect that mints fresh credentials
 * and returns the fully-formed `/ws` URL. The supervisor runs it at the top of
 * EVERY connect attempt, so a failed mint is just another attempt failure —
 * transient mints back off and retry; a `ConnectionBlockedError` (the server
 * rejected the credential) parks the supervisor. The supervisor stays
 * transport-agnostic.
 */
export interface PreparedConnection {
  readonly label: string;
  readonly prepareSocketUrl: Effect.Effect<string, ConnectionAttemptError>;
}

/**
 * The coarse connection phase the UI renders. `connecting` covers the very first
 * attempt; once we have been connected at least once, subsequent attempts show
 * as `reconnecting` so the status dot can distinguish a cold start from a blip.
 * `offline` means the platform reports no network (no attempts are made until
 * it returns); `blocked` means the last attempt failed in a way retrying can't
 * fix (see `ConnectionBlockedError`).
 */
export type ConnectionPhase =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline"
  | "blocked";

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
