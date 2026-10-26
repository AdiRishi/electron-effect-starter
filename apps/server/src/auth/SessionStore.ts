// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac or timingSafeEqual.
import * as NodeCrypto from "node:crypto";

import { AuthSessionId, ServerAuthSessionMethod } from "@app/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "./ServerSecretStore.ts";

const SIGNING_SECRET_NAME = "session-signing-key";
const SESSION_TTL = Duration.days(30);
const WEBSOCKET_TICKET_TTL = Duration.minutes(5);

export interface Session {
  readonly sessionId: AuthSessionId;
  readonly method: ServerAuthSessionMethod;
  readonly expiresAt: DateTime.Utc;
}

export interface IssuedSession extends Session {
  readonly token: string;
}

export class SessionIssueError extends Schema.TaggedError<SessionIssueError>()(
  "SessionIssueError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to issue a session credential.";
  }
}

export class SessionCredentialInvalidError extends Schema.TaggedError<SessionCredentialInvalidError>()(
  "SessionCredentialInvalidError",
  { reason: Schema.Literals(["malformed", "bad_signature", "bad_payload", "expired"]) },
) {
  override get message(): string {
    return `The session credential is invalid (${this.reason}).`;
  }
}

const SessionClaims = Schema.Struct({
  v: Schema.Literal(1),
  kind: Schema.Literal("session"),
  sid: AuthSessionId,
  method: ServerAuthSessionMethod,
  iat: Schema.Number,
  exp: Schema.Number,
});

const WebSocketClaims = Schema.Struct({
  v: Schema.Literal(1),
  kind: Schema.Literal("websocket"),
  sid: AuthSessionId,
  method: ServerAuthSessionMethod,
  /** When the session behind the ticket expires; the socket closes then. */
  sexp: Schema.Number,
  iat: Schema.Number,
  exp: Schema.Number,
});

const encodeSessionClaims = Schema.encodeEffect(Schema.fromJsonString(SessionClaims));
const decodeSessionClaims = Schema.decodeEffect(Schema.fromJsonString(SessionClaims));
const encodeWebSocketClaims = Schema.encodeEffect(Schema.fromJsonString(WebSocketClaims));
const decodeWebSocketClaims = Schema.decodeEffect(Schema.fromJsonString(WebSocketClaims));

const sign = (payload: string, secret: Uint8Array) =>
  NodeCrypto.createHmac("sha256", secret).update(payload).digest("base64url");

const signaturesMatch = (left: string, right: string) => {
  const leftBuffer = Buffer.from(left, "base64url");
  const rightBuffer = Buffer.from(right, "base64url");
  return (
    leftBuffer.length === rightBuffer.length && NodeCrypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
};

/**
 * Issues and verifies HMAC-signed session tokens and short-lived WebSocket tickets. Tokens are
 * stateless: the signing key persists in the secret store, so sessions survive restarts, and
 * rotating the key revokes every session at once.
 */
export class SessionStore extends Context.Service<
  SessionStore,
  {
    readonly issue: (input: {
      readonly method: ServerAuthSessionMethod;
    }) => Effect.Effect<IssuedSession, SessionIssueError>;
    readonly verify: (token: string) => Effect.Effect<Session, SessionCredentialInvalidError>;
    readonly issueWebSocketTicket: (
      session: Session,
    ) => Effect.Effect<
      { readonly ticket: string; readonly expiresAt: DateTime.Utc },
      SessionIssueError
    >;
    readonly verifyWebSocketTicket: (
      ticket: string,
    ) => Effect.Effect<Session, SessionCredentialInvalidError>;
  }
>()("@app/server/auth/SessionStore") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const signingSecret = yield* secrets.getOrCreateRandom(SIGNING_SECRET_NAME, 32);

  const seal = (encodedPayload: string) =>
    `${encodedPayload}.${sign(encodedPayload, signingSecret)}`;

  const open = Effect.fnUntraced(function* (token: string) {
    const [encodedPayload, signature, ...rest] = token.split(".");
    if (!encodedPayload || !signature || rest.length > 0) {
      return yield* new SessionCredentialInvalidError({ reason: "malformed" });
    }
    if (!signaturesMatch(signature, sign(encodedPayload, signingSecret))) {
      return yield* new SessionCredentialInvalidError({ reason: "bad_signature" });
    }
    return Buffer.from(encodedPayload, "base64url").toString("utf8");
  });

  const issue = Effect.fn("SessionStore.issue")(function* (input: {
    readonly method: ServerAuthSessionMethod;
  }) {
    const sessionId = AuthSessionId.make(
      yield* crypto
        .randomUUIDv4()
        .pipe(Effect.mapError((cause) => new SessionIssueError({ cause }))),
    );
    const issuedAt = yield* DateTime.now;
    const expiresAt = DateTime.addDuration(issuedAt, SESSION_TTL);
    const payload = yield* encodeSessionClaims({
      v: 1,
      kind: "session",
      sid: sessionId,
      method: input.method,
      iat: issuedAt.epochMilliseconds,
      exp: expiresAt.epochMilliseconds,
    }).pipe(Effect.mapError((cause) => new SessionIssueError({ cause })));
    return {
      sessionId,
      method: input.method,
      expiresAt,
      token: seal(Buffer.from(payload, "utf8").toString("base64url")),
    } satisfies IssuedSession;
  });

  const verify = Effect.fn("SessionStore.verify")(function* (token: string) {
    const claims = yield* open(token).pipe(
      Effect.flatMap(decodeSessionClaims),
      Effect.catchTags({
        SchemaError: () => new SessionCredentialInvalidError({ reason: "bad_payload" }),
      }),
    );
    const now = yield* DateTime.now;
    if (claims.exp <= now.epochMilliseconds) {
      return yield* new SessionCredentialInvalidError({ reason: "expired" });
    }
    return {
      sessionId: claims.sid,
      method: claims.method,
      expiresAt: DateTime.makeUnsafe(claims.exp),
    } satisfies Session;
  });

  const issueWebSocketTicket = Effect.fn("SessionStore.issueWebSocketTicket")(function* (
    session: Session,
  ) {
    const issuedAt = yield* DateTime.now;
    const ticketExpiry = DateTime.addDuration(issuedAt, WEBSOCKET_TICKET_TTL);
    const expiresAt = DateTime.min(ticketExpiry, session.expiresAt);
    const payload = yield* encodeWebSocketClaims({
      v: 1,
      kind: "websocket",
      sid: session.sessionId,
      method: session.method,
      sexp: session.expiresAt.epochMilliseconds,
      iat: issuedAt.epochMilliseconds,
      exp: expiresAt.epochMilliseconds,
    }).pipe(Effect.mapError((cause) => new SessionIssueError({ cause })));
    return { ticket: seal(Buffer.from(payload, "utf8").toString("base64url")), expiresAt };
  });

  const verifyWebSocketTicket = Effect.fn("SessionStore.verifyWebSocketTicket")(function* (
    ticket: string,
  ) {
    const claims = yield* open(ticket).pipe(
      Effect.flatMap(decodeWebSocketClaims),
      Effect.catchTags({
        SchemaError: () => new SessionCredentialInvalidError({ reason: "bad_payload" }),
      }),
    );
    const now = yield* DateTime.now;
    if (claims.exp <= now.epochMilliseconds) {
      return yield* new SessionCredentialInvalidError({ reason: "expired" });
    }
    return {
      sessionId: claims.sid,
      method: claims.method,
      expiresAt: DateTime.makeUnsafe(claims.sexp),
    } satisfies Session;
  });

  return SessionStore.of({ issue, verify, issueWebSocketTicket, verifyWebSocketTicket });
});

export const layer = Layer.effect(SessionStore, make);
