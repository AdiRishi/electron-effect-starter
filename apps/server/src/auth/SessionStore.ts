import { AuthSessionId, ServerAuthSessionMethod } from "@app/contracts";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "./utils.ts";

export interface IssuedSession {
  readonly sessionId: AuthSessionId;
  readonly token: string;
  readonly method: ServerAuthSessionMethod;
  readonly expiresAt: DateTime.Utc;
}

export interface VerifiedSession {
  readonly sessionId: AuthSessionId;
  readonly token: string;
  readonly method: ServerAuthSessionMethod;
  readonly expiresAt: DateTime.Utc;
  readonly subject: string;
}

export class MalformedSessionTokenError extends Schema.TaggedError<MalformedSessionTokenError>()(
  "MalformedSessionTokenError",
  {},
) {
  override get message(): string {
    return "Malformed session token.";
  }
}

export class InvalidSessionTokenSignatureError extends Schema.TaggedError<InvalidSessionTokenSignatureError>()(
  "InvalidSessionTokenSignatureError",
  {},
) {
  override get message(): string {
    return "Invalid session token signature.";
  }
}

export class InvalidSessionTokenPayloadError extends Schema.TaggedError<InvalidSessionTokenPayloadError>()(
  "InvalidSessionTokenPayloadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Invalid session token payload.";
  }
}

export class SessionTokenExpiredError extends Schema.TaggedError<SessionTokenExpiredError>()(
  "SessionTokenExpiredError",
  {
    sessionId: AuthSessionId,
    expiresAt: Schema.DateTimeUtc,
    observedAt: Schema.DateTimeUtc,
  },
) {
  override get message(): string {
    return "Session token expired.";
  }
}

export class UnknownSessionTokenError extends Schema.TaggedError<UnknownSessionTokenError>()(
  "UnknownSessionTokenError",
  { sessionId: AuthSessionId },
) {
  override get message(): string {
    return "Unknown session token.";
  }
}

export class SessionTokenRevokedError extends Schema.TaggedError<SessionTokenRevokedError>()(
  "SessionTokenRevokedError",
  { sessionId: AuthSessionId, revokedAt: Schema.DateTimeUtc },
) {
  override get message(): string {
    return "Session token revoked.";
  }
}

export class InvalidSessionExpirationClaimError extends Schema.TaggedError<InvalidSessionExpirationClaimError>()(
  "InvalidSessionExpirationClaimError",
  { sessionId: AuthSessionId, expirationClaim: Schema.Number },
) {
  override get message(): string {
    return "Invalid `exp` claim";
  }
}

export class MalformedWebSocketTokenError extends Schema.TaggedError<MalformedWebSocketTokenError>()(
  "MalformedWebSocketTokenError",
  {},
) {
  override get message(): string {
    return "Malformed websocket token.";
  }
}

export class InvalidWebSocketTokenSignatureError extends Schema.TaggedError<InvalidWebSocketTokenSignatureError>()(
  "InvalidWebSocketTokenSignatureError",
  {},
) {
  override get message(): string {
    return "Invalid websocket token signature.";
  }
}

export class InvalidWebSocketTokenPayloadError extends Schema.TaggedError<InvalidWebSocketTokenPayloadError>()(
  "InvalidWebSocketTokenPayloadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Invalid websocket token payload.";
  }
}

export class WebSocketTokenExpiredError extends Schema.TaggedError<WebSocketTokenExpiredError>()(
  "WebSocketTokenExpiredError",
  {
    sessionId: AuthSessionId,
    expiresAt: Schema.DateTimeUtc,
    observedAt: Schema.DateTimeUtc,
  },
) {
  override get message(): string {
    return "Websocket token expired.";
  }
}

export class UnknownWebSocketSessionError extends Schema.TaggedError<UnknownWebSocketSessionError>()(
  "UnknownWebSocketSessionError",
  { sessionId: AuthSessionId },
) {
  override get message(): string {
    return "Unknown websocket session.";
  }
}

export class WebSocketSessionExpiredError extends Schema.TaggedError<WebSocketSessionExpiredError>()(
  "WebSocketSessionExpiredError",
  {
    sessionId: AuthSessionId,
    expiresAt: Schema.DateTimeUtc,
    observedAt: Schema.DateTimeUtc,
  },
) {
  override get message(): string {
    return "Websocket session expired.";
  }
}

export class WebSocketSessionRevokedError extends Schema.TaggedError<WebSocketSessionRevokedError>()(
  "WebSocketSessionRevokedError",
  { sessionId: AuthSessionId, revokedAt: Schema.DateTimeUtc },
) {
  override get message(): string {
    return "Websocket session revoked.";
  }
}

export const SessionCredentialInvalidError = Schema.Union([
  MalformedSessionTokenError,
  InvalidSessionTokenSignatureError,
  InvalidSessionTokenPayloadError,
  SessionTokenExpiredError,
  UnknownSessionTokenError,
  SessionTokenRevokedError,
  InvalidSessionExpirationClaimError,
  MalformedWebSocketTokenError,
  InvalidWebSocketTokenSignatureError,
  InvalidWebSocketTokenPayloadError,
  WebSocketTokenExpiredError,
  UnknownWebSocketSessionError,
  WebSocketSessionExpiredError,
  WebSocketSessionRevokedError,
]);

export type SessionCredentialInvalidError = typeof SessionCredentialInvalidError.Type;

export const isSessionCredentialInvalidError = Schema.is(SessionCredentialInvalidError);

const sessionCredentialInternalErrorContext = {
  cause: Schema.Defect(),
};

export class SessionClaimsEncodingError extends Schema.TaggedError<SessionClaimsEncodingError>()(
  "SessionClaimsEncodingError",
  {
    sessionId: AuthSessionId,
    operation: Schema.Literals(["encode_session_claims", "encode_websocket_claims"]),
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to encode claims";
  }
}

export class SessionCredentialIssueError extends Schema.TaggedError<SessionCredentialIssueError>()(
  "SessionCredentialIssueError",
  {
    sessionId: Schema.optional(AuthSessionId),
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to issue session credential.";
  }
}

export class SessionCredentialVerificationError extends Schema.TaggedError<SessionCredentialVerificationError>()(
  "SessionCredentialVerificationError",
  { sessionId: AuthSessionId, ...sessionCredentialInternalErrorContext },
) {
  override get message(): string {
    return "Failed to verify session credential.";
  }
}

export class WebSocketTokenIssueError extends Schema.TaggedError<WebSocketTokenIssueError>()(
  "WebSocketTokenIssueError",
  { sessionId: AuthSessionId, ...sessionCredentialInternalErrorContext },
) {
  override get message(): string {
    return "Failed to issue websocket token.";
  }
}

export class WebSocketTokenVerificationError extends Schema.TaggedError<WebSocketTokenVerificationError>()(
  "WebSocketTokenVerificationError",
  { sessionId: AuthSessionId, ...sessionCredentialInternalErrorContext },
) {
  override get message(): string {
    return "Failed to verify websocket token.";
  }
}

export class SessionRevocationError extends Schema.TaggedError<SessionRevocationError>()(
  "SessionRevocationError",
  { sessionId: AuthSessionId, ...sessionCredentialInternalErrorContext },
) {
  override get message(): string {
    return "Failed to revoke session.";
  }
}

export class OtherSessionsRevocationError extends Schema.TaggedError<OtherSessionsRevocationError>()(
  "OtherSessionsRevocationError",
  { currentSessionId: AuthSessionId, ...sessionCredentialInternalErrorContext },
) {
  override get message(): string {
    return "Failed to revoke other sessions.";
  }
}

export const SessionCredentialInternalError = Schema.Union([
  SessionClaimsEncodingError,
  SessionCredentialIssueError,
  SessionCredentialVerificationError,
  WebSocketTokenIssueError,
  WebSocketTokenVerificationError,
  SessionRevocationError,
  OtherSessionsRevocationError,
]);

export type SessionCredentialInternalError = typeof SessionCredentialInternalError.Type;

export const SessionCredentialError = Schema.Union([
  SessionCredentialInvalidError,
  SessionCredentialInternalError,
]);

export type SessionCredentialError = typeof SessionCredentialError.Type;

/**
 * Issues HMAC-signed session tokens and short-lived WebSocket tickets, each backed by an
 * `auth_sessions` row. A token verifies only while its row is unrevoked, so revoking a session
 * rejects its token and closes its sockets. The signing key persists in the secret store, so
 * sessions survive restarts.
 */
export class SessionStore extends Context.Service<
  SessionStore,
  {
    readonly issue: (input?: {
      readonly subject?: string;
      readonly method?: ServerAuthSessionMethod;
      readonly replaceActiveForSubjectAndMethod?: boolean;
      readonly replaceSessionId?: AuthSessionId;
    }) => Effect.Effect<IssuedSession, SessionCredentialInternalError>;
    readonly verify: (token: string) => Effect.Effect<VerifiedSession, SessionCredentialError>;
    readonly issueWebSocketToken: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<
      { readonly token: string; readonly expiresAt: DateTime.Utc },
      SessionCredentialInternalError
    >;
    readonly verifyWebSocketToken: (
      token: string,
    ) => Effect.Effect<VerifiedSession, SessionCredentialError>;
    /** Completes when the session is revoked, replaced or expires. */
    readonly awaitInvalidation: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<void, SessionCredentialVerificationError>;
    readonly revoke: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<boolean, SessionCredentialInternalError>;
    readonly revokeAllExcept: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<number, SessionCredentialInternalError>;
  }
>()("@app/server/auth/SessionStore") {}

const SIGNING_SECRET_NAME = "session-signing-key";
const DEFAULT_SESSION_TTL = Duration.days(30);
const DEFAULT_WEBSOCKET_TOKEN_TTL = Duration.minutes(5);

const SessionClaims = Schema.Struct({
  v: Schema.Literal(1),
  kind: Schema.Literal("session"),
  sid: AuthSessionId,
  sub: Schema.String,
  method: ServerAuthSessionMethod,
  iat: Schema.Number,
  exp: Schema.Number,
});

type SessionClaims = typeof SessionClaims.Type;

const WebSocketClaims = Schema.Struct({
  v: Schema.Literal(1),
  kind: Schema.Literal("websocket"),
  sid: AuthSessionId,
  iat: Schema.Number,
  exp: Schema.Number,
});

type WebSocketClaims = typeof WebSocketClaims.Type;

const decodeSessionClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionClaims));
const decodeWebSocketClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(WebSocketClaims));
const encodeClaims = Schema.encodeEffect(Schema.fromJsonString(SessionClaims));
const encodeWsClaims = Schema.encodeEffect(Schema.fromJsonString(WebSocketClaims));

/** A token is exactly `payload.signature`; anything else, such as a third segment, is malformed. */
function splitToken(token: string): readonly [string, string] | undefined {
  const [encodedPayload, signature, ...rest] = token.split(".");

  return encodedPayload && signature && rest.length === 0 ? [encodedPayload, signature] : undefined;
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const authSessions = yield* AuthSessions.AuthSessionRepository;
  const signingSecret = yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
  const removedSessions = yield* PubSub.unbounded<AuthSessionId>();

  const emitRemoved = (sessionId: AuthSessionId) =>
    PubSub.publish(removedSessions, sessionId).pipe(Effect.asVoid);

  const issue: SessionStore["Service"]["issue"] = Effect.fn("SessionStore.issue")(
    function* (input) {
      const sessionId = AuthSessionId.make(
        yield* crypto
          .randomUUIDv4()
          .pipe(Effect.mapError((cause) => new SessionCredentialIssueError({ cause }))),
      );

      const issuedAt = yield* DateTime.now;
      const expiresAt = DateTime.addDuration(issuedAt, DEFAULT_SESSION_TTL);

      const claims: SessionClaims = {
        v: 1,
        kind: "session",
        sid: sessionId,
        sub: input?.subject ?? "browser",
        method: input?.method ?? "browser-session-cookie",
        iat: issuedAt.epochMilliseconds,
        exp: expiresAt.epochMilliseconds,
      };

      const encodedPayload = yield* encodeClaims(claims).pipe(
        Effect.map(base64UrlEncode),
        Effect.mapError(
          (cause) =>
            new SessionCredentialIssueError({
              sessionId,
              cause: new SessionClaimsEncodingError({
                sessionId,
                operation: "encode_session_claims",
                cause,
              }),
            }),
        ),
      );

      const signature = signPayload(encodedPayload, signingSecret);

      const sessionRecord = {
        sessionId,
        subject: claims.sub,
        method: claims.method,
        issuedAt,
        expiresAt,
      } satisfies AuthSessions.CreateAuthSessionInput;

      const replacedSessionIds = yield* (
        input?.replaceSessionId !== undefined || input?.replaceActiveForSubjectAndMethod
          ? authSessions.createReplacingActive({
              session: sessionRecord,
              revokedAt: issuedAt,
              ...(input.replaceSessionId !== undefined
                ? { replaceSessionId: input.replaceSessionId }
                : {}),
            })
          : authSessions.create(sessionRecord).pipe(Effect.as(Arr.empty<AuthSessionId>()))
      ).pipe(Effect.mapError((cause) => new SessionCredentialIssueError({ sessionId, cause })));

      yield* Effect.forEach(replacedSessionIds, emitRemoved, {
        concurrency: "unbounded",
        discard: true,
      });

      return {
        sessionId,
        token: `${encodedPayload}.${signature}`,
        method: claims.method,
        expiresAt,
      } satisfies IssuedSession;
    },
  );

  const verify: SessionStore["Service"]["verify"] = Effect.fn("SessionStore.verify")(
    function* (token) {
      const parts = splitToken(token);

      if (parts === undefined) {
        return yield* new MalformedSessionTokenError({});
      }

      const [encodedPayload, signature] = parts;
      const expectedSignature = signPayload(encodedPayload, signingSecret);

      if (!timingSafeEqualBase64Url(signature, expectedSignature)) {
        return yield* new InvalidSessionTokenSignatureError({});
      }

      const claims = yield* decodeSessionClaims(base64UrlDecodeUtf8(encodedPayload)).pipe(
        Effect.mapError((cause) => new InvalidSessionTokenPayloadError({ cause })),
      );

      const observedAt = yield* DateTime.now;
      const expiresAt = DateTime.make(claims.exp);

      if (Option.isNone(expiresAt)) {
        return yield* new InvalidSessionExpirationClaimError({
          sessionId: claims.sid,
          expirationClaim: claims.exp,
        });
      }

      if (claims.exp <= observedAt.epochMilliseconds) {
        return yield* new SessionTokenExpiredError({
          sessionId: claims.sid,
          expiresAt: expiresAt.value,
          observedAt,
        });
      }

      const row = yield* authSessions
        .getById({ sessionId: claims.sid })
        .pipe(
          Effect.mapError(
            (cause) => new SessionCredentialVerificationError({ sessionId: claims.sid, cause }),
          ),
        );

      if (Option.isNone(row)) {
        return yield* new UnknownSessionTokenError({ sessionId: claims.sid });
      }

      if (row.value.revokedAt !== null) {
        return yield* new SessionTokenRevokedError({
          sessionId: claims.sid,
          revokedAt: row.value.revokedAt,
        });
      }

      return {
        sessionId: claims.sid,
        token,
        method: claims.method,
        expiresAt: expiresAt.value,
        subject: claims.sub,
      } satisfies VerifiedSession;
    },
  );

  const issueWebSocketToken: SessionStore["Service"]["issueWebSocketToken"] = Effect.fn(
    "SessionStore.issueWebSocketToken",
  )(function* (sessionId) {
    const issuedAt = yield* DateTime.now;
    const expiresAt = DateTime.addDuration(issuedAt, DEFAULT_WEBSOCKET_TOKEN_TTL);

    const claims: WebSocketClaims = {
      v: 1,
      kind: "websocket",
      sid: sessionId,
      iat: issuedAt.epochMilliseconds,
      exp: expiresAt.epochMilliseconds,
    };

    const encodedPayload = yield* encodeWsClaims(claims).pipe(
      Effect.map(base64UrlEncode),
      Effect.mapError(
        (cause) =>
          new WebSocketTokenIssueError({
            sessionId,
            cause: new SessionClaimsEncodingError({
              sessionId,
              operation: "encode_websocket_claims",
              cause,
            }),
          }),
      ),
    );

    const signature = signPayload(encodedPayload, signingSecret);

    return { token: `${encodedPayload}.${signature}`, expiresAt };
  });

  const verifyWebSocketToken: SessionStore["Service"]["verifyWebSocketToken"] = Effect.fn(
    "SessionStore.verifyWebSocketToken",
  )(function* (token) {
    const parts = splitToken(token);

    if (parts === undefined) {
      return yield* new MalformedWebSocketTokenError({});
    }

    const [encodedPayload, signature] = parts;
    const expectedSignature = signPayload(encodedPayload, signingSecret);

    if (!timingSafeEqualBase64Url(signature, expectedSignature)) {
      return yield* new InvalidWebSocketTokenSignatureError({});
    }

    const claims = yield* decodeWebSocketClaims(base64UrlDecodeUtf8(encodedPayload)).pipe(
      Effect.mapError((cause) => new InvalidWebSocketTokenPayloadError({ cause })),
    );

    const observedAt = yield* DateTime.now;
    const expiresAt = DateTime.make(claims.exp);

    if (Option.isNone(expiresAt)) {
      return yield* new InvalidSessionExpirationClaimError({
        sessionId: claims.sid,
        expirationClaim: claims.exp,
      });
    }

    if (claims.exp <= observedAt.epochMilliseconds) {
      return yield* new WebSocketTokenExpiredError({
        sessionId: claims.sid,
        expiresAt: expiresAt.value,
        observedAt,
      });
    }

    const row = yield* authSessions
      .getById({ sessionId: claims.sid })
      .pipe(
        Effect.mapError(
          (cause) => new WebSocketTokenVerificationError({ sessionId: claims.sid, cause }),
        ),
      );

    if (Option.isNone(row)) {
      return yield* new UnknownWebSocketSessionError({ sessionId: claims.sid });
    }

    if (row.value.expiresAt.epochMilliseconds <= observedAt.epochMilliseconds) {
      return yield* new WebSocketSessionExpiredError({
        sessionId: claims.sid,
        expiresAt: row.value.expiresAt,
        observedAt,
      });
    }

    if (row.value.revokedAt !== null) {
      return yield* new WebSocketSessionRevokedError({
        sessionId: claims.sid,
        revokedAt: row.value.revokedAt,
      });
    }

    return {
      sessionId: row.value.sessionId,
      token,
      method: row.value.method,
      expiresAt: row.value.expiresAt,
      subject: row.value.subject,
    } satisfies VerifiedSession;
  });

  const revoke: SessionStore["Service"]["revoke"] = Effect.fn("SessionStore.revoke")(
    function* (sessionId) {
      const revokedAt = yield* DateTime.now;

      const revoked = yield* authSessions
        .revoke({ sessionId, revokedAt })
        .pipe(Effect.mapError((cause) => new SessionRevocationError({ sessionId, cause })));

      if (revoked) {
        yield* emitRemoved(sessionId);
      }

      return revoked;
    },
  );

  const revokeAllExcept: SessionStore["Service"]["revokeAllExcept"] = Effect.fn(
    "SessionStore.revokeAllExcept",
  )(function* (sessionId) {
    const revokedAt = yield* DateTime.now;

    const revokedSessionIds = yield* authSessions
      .revokeAllExcept({ currentSessionId: sessionId, revokedAt })
      .pipe(
        Effect.mapError(
          (cause) => new OtherSessionsRevocationError({ currentSessionId: sessionId, cause }),
        ),
      );

    yield* Effect.forEach(revokedSessionIds, emitRemoved, {
      concurrency: "unbounded",
      discard: true,
    });

    return revokedSessionIds.length;
  });

  const awaitInvalidation = Effect.fn("SessionStore.awaitInvalidation")(function* (
    sessionId: AuthSessionId,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        // Subscribe before reading: revocation can race with the WebSocket upgrade.
        const subscription = yield* PubSub.subscribe(removedSessions);

        const row = yield* authSessions
          .getById({ sessionId })
          .pipe(
            Effect.mapError(
              (cause) => new SessionCredentialVerificationError({ sessionId, cause }),
            ),
          );

        if (Option.isNone(row) || row.value.revokedAt !== null) return;
        const now = yield* DateTime.now;
        const remaining = row.value.expiresAt.epochMilliseconds - now.epochMilliseconds;

        if (remaining <= 0) return;
        yield* Effect.raceFirst(
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((removedSessionId) => removedSessionId === sessionId),
            Stream.runHead,
          ),
          Effect.sleep(Duration.millis(remaining)),
        );
      }),
    );
  });

  return SessionStore.of({
    issue,
    verify,
    issueWebSocketToken,
    verifyWebSocketToken,
    awaitInvalidation,
    revoke,
    revokeAllExcept,
  });
});

export const layer = Layer.effect(SessionStore, make).pipe(Layer.provideMerge(AuthSessions.layer));
