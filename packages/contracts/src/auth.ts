import * as Schema from "effect/Schema";

/**
 * The single shared authorization error for every WS RPC. The server's `/ws`
 * upgrade is gated by a bearer session; a request without a valid session
 * fails with this. Keeping one shared error keeps the RPC group's error
 * unions small and uniform.
 */
export class EnvironmentAuthorizationError extends Schema.TaggedErrorClass<EnvironmentAuthorizationError>()(
  "EnvironmentAuthorizationError",
  {
    reason: Schema.Literals(["missing-credential", "invalid-credential", "expired"]),
  },
) {
  override get message(): string {
    return `WebSocket request was not authorized (${this.reason}).`;
  }
}

/**
 * Body of `POST /api/auth/bootstrap/bearer`. The desktop shell mints a
 * bootstrap token, hands it to the spawned server AND to the renderer (over
 * IPC); the renderer exchanges the token here for a short-lived bearer session
 * it then uses on the `/ws` upgrade. This is the "shared secret handed to a
 * trusted child" pattern.
 */
export const BootstrapBearerInput = Schema.Struct({
  credential: Schema.String,
  clientMetadata: Schema.optionalKey(
    Schema.Struct({
      label: Schema.String,
      deviceType: Schema.Literals(["desktop", "web", "mobile"]),
    }),
  ),
});
export type BootstrapBearerInput = typeof BootstrapBearerInput.Type;

export const BearerSession = Schema.Struct({
  access_token: Schema.String,
  /** Unix millis when the token expires, or null for "session lifetime". */
  expires_at: Schema.NullOr(Schema.Number),
});
export type BearerSession = typeof BearerSession.Type;

export class BootstrapBearerError extends Schema.TaggedErrorClass<BootstrapBearerError>()(
  "BootstrapBearerError",
  {
    reason: Schema.Literals(["invalid-credential", "server-unreachable"]),
  },
) {
  override get message(): string {
    return `Failed to bootstrap a bearer session (${this.reason}).`;
  }
}
