import * as Schema from "effect/Schema";

/**
 * Everything the supervisor needs to open one socket: the fully-formed WS URL
 * (already carrying the bearer token as a query param) plus a human label for
 * diagnostics. The web app builds this from the integration contract before
 * handing it to the supervisor — the supervisor itself is transport-agnostic.
 */
export interface PreparedConnection {
  readonly label: string;
  readonly socketUrl: string;
}

/**
 * The single transient error the client transport surfaces. A dropped socket or
 * a failed open both collapse to this; the supervisor treats it as "retry after
 * backoff". Kept deliberately small — a starter has one failure mode.
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
 * The coarse connection phase the UI renders. `connecting` covers the very first
 * attempt; once we have been connected at least once, subsequent attempts show
 * as `reconnecting` so the status dot can distinguish a cold start from a blip.
 */
export type ConnectionPhase = "idle" | "connecting" | "connected" | "reconnecting";

export interface ConnectionState {
  readonly phase: ConnectionPhase;
  /** How many failed attempts since the last successful connection. */
  readonly attempt: number;
  /** Detail of the most recent failure, or null while healthy. */
  readonly lastError: string | null;
}

export const INITIAL_CONNECTION_STATE: ConnectionState = Object.freeze({
  phase: "idle",
  attempt: 0,
  lastError: null,
});
