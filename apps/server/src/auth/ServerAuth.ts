import {
  AuthAccessTokenType,
  DESKTOP_RENDERER_ORIGINS,
  WS_TICKET_QUERY_PARAM,
  type AuthAccessTokenResult,
  type AuthBrowserSessionResult,
  type AuthSessionId,
  type AuthSessionState,
  type AuthWebSocketTicketResult,
  type ServerAuthSessionMethod,
} from "@app/contracts";
import { setPairingTokenOnUrl } from "@app/shared/pairingUrl";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { HttpServerRequest } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as BootstrapCredentials from "./BootstrapCredentials.ts";
import * as SessionStore from "./SessionStore.ts";

export interface AuthenticatedSession {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly method: ServerAuthSessionMethod;
  readonly expiresAt: DateTime.Utc;
}

const serverAuthInternalErrorContext = {
  cause: Schema.Defect(),
};

export class ServerAuthSessionCredentialValidationError extends Schema.TaggedError<ServerAuthSessionCredentialValidationError>()(
  "ServerAuthSessionCredentialValidationError",
  { ...serverAuthInternalErrorContext },
) {
  override get message(): string {
    return "Failed to validate session credential.";
  }
}

export class ServerAuthAuthenticatedSessionIssueError extends Schema.TaggedError<ServerAuthAuthenticatedSessionIssueError>()(
  "ServerAuthAuthenticatedSessionIssueError",
  { ...serverAuthInternalErrorContext },
) {
  override get message(): string {
    return "Failed to issue authenticated session.";
  }
}

export class ServerAuthAuthenticatedAccessTokenIssueError extends Schema.TaggedError<ServerAuthAuthenticatedAccessTokenIssueError>()(
  "ServerAuthAuthenticatedAccessTokenIssueError",
  { ...serverAuthInternalErrorContext },
) {
  override get message(): string {
    return "Failed to issue authenticated access token.";
  }
}

export class ServerAuthPairingLinkCreationError extends Schema.TaggedError<ServerAuthPairingLinkCreationError>()(
  "ServerAuthPairingLinkCreationError",
  { ...serverAuthInternalErrorContext },
) {
  override get message(): string {
    return "Failed to create pairing link.";
  }
}

export class ServerAuthWebSocketTokenIssueError extends Schema.TaggedError<ServerAuthWebSocketTokenIssueError>()(
  "ServerAuthWebSocketTokenIssueError",
  { ...serverAuthInternalErrorContext },
) {
  override get message(): string {
    return "Failed to issue websocket token.";
  }
}

export const ServerAuthInternalError = Schema.Union([
  ServerAuthSessionCredentialValidationError,
  ServerAuthAuthenticatedSessionIssueError,
  ServerAuthAuthenticatedAccessTokenIssueError,
  ServerAuthPairingLinkCreationError,
  ServerAuthWebSocketTokenIssueError,
]);

export type ServerAuthInternalError = typeof ServerAuthInternalError.Type;

export const isServerAuthInternalError = Schema.is(ServerAuthInternalError);

export class ServerAuthMissingCredentialError extends Schema.TaggedError<ServerAuthMissingCredentialError>()(
  "ServerAuthMissingCredentialError",
  {},
) {
  override get message(): string {
    return "Server authentication credential is missing.";
  }
}

export class ServerAuthInvalidCredentialError extends Schema.TaggedError<ServerAuthInvalidCredentialError>()(
  "ServerAuthInvalidCredentialError",
  {
    diagnostic: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Server authentication credential is invalid.";
  }
}

export const ServerAuthCredentialError = Schema.Union([
  ServerAuthMissingCredentialError,
  ServerAuthInvalidCredentialError,
]);

export type ServerAuthCredentialError = typeof ServerAuthCredentialError.Type;

export const isServerAuthCredentialError = Schema.is(ServerAuthCredentialError);

export const serverAuthCredentialReason = (
  error: ServerAuthCredentialError,
): "missing_credential" | "invalid_credential" =>
  Predicate.isTagged(error, "ServerAuthMissingCredentialError")
    ? "missing_credential"
    : "invalid_credential";

/**
 * Turns bootstrap credentials into sessions and authenticates requests and WebSocket upgrades.
 * Browsers hold an HttpOnly cookie; the desktop renderer holds a bearer token and trades it for a
 * WebSocket ticket, because a browser WebSocket cannot send an Authorization header.
 */
export class ServerAuth extends Context.Service<
  ServerAuth,
  {
    readonly authenticateRequest: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<AuthenticatedSession, ServerAuthCredentialError | ServerAuthInternalError>;
    readonly authenticateWebSocketUpgrade: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<AuthenticatedSession, ServerAuthCredentialError | ServerAuthInternalError>;
    readonly getSessionState: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<AuthSessionState, ServerAuthInternalError>;
    readonly createBrowserSession: (
      credential: string,
      previousSessionToken?: string,
    ) => Effect.Effect<
      { readonly response: AuthBrowserSessionResult; readonly sessionToken: string },
      ServerAuthInvalidCredentialError | ServerAuthInternalError
    >;
    readonly exchangeBootstrapCredential: (
      credential: string,
    ) => Effect.Effect<
      AuthAccessTokenResult,
      ServerAuthInvalidCredentialError | ServerAuthInternalError
    >;
    readonly issueWebSocketTicket: (
      session: Pick<AuthenticatedSession, "sessionId">,
    ) => Effect.Effect<AuthWebSocketTicketResult, ServerAuthInternalError>;
    readonly issueStartupPairingUrl: (
      baseUrl: string,
    ) => Effect.Effect<string, ServerAuthInternalError>;
  }
>()("@app/server/auth/ServerAuth") {}

const AUTHORIZATION_PREFIX = "Bearer ";

const mapSessionVerificationErrors = <A, R>(
  effect: Effect.Effect<A, SessionStore.SessionCredentialError, R>,
): Effect.Effect<A, ServerAuthInvalidCredentialError | ServerAuthInternalError, R> =>
  effect.pipe(
    Effect.mapError((cause) =>
      SessionStore.isSessionCredentialInvalidError(cause)
        ? new ServerAuthInvalidCredentialError({ cause })
        : new ServerAuthSessionCredentialValidationError({ cause }),
    ),
  );

function parseBearerToken(request: HttpServerRequest.HttpServerRequest): string | null {
  const header = request.headers["authorization"];

  if (header === undefined || !header.startsWith(AUTHORIZATION_PREFIX)) {
    return null;
  }

  const token = header.slice(AUTHORIZATION_PREFIX.length).trim();

  return token.length > 0 ? token : null;
}

export function selectRequestCredential(
  request: HttpServerRequest.HttpServerRequest,
  cookieName: string,
) {
  const cookieToken = request.cookies[cookieName];

  if (cookieToken !== undefined) {
    return { token: cookieToken, source: "cookie" } as const;
  }

  const bearerToken = parseBearerToken(request);

  if (bearerToken !== null) {
    return { token: bearerToken, source: "bearer" } as const;
  }

  return undefined;
}

function firstHeaderValue(value: string | undefined): string | undefined {
  const first = value?.split(",")[0]?.trim().toLowerCase();

  return first && first.length > 0 ? first : undefined;
}

// Missing Origin allows same-origin reads and non-browser clients; otherwise require
// same-origin Sec-Fetch-Site, this server's host (including X-Forwarded-Host), or a trusted app origin.
function isBrowserOriginAllowed(
  request: HttpServerRequest.HttpServerRequest,
  trustedOrigins: ReadonlySet<string>,
): boolean {
  const origin = request.headers.origin;

  if (origin === undefined) return true;

  if (request.headers["sec-fetch-site"] === "same-origin") return true;

  if (trustedOrigins.has(origin)) return true;
  let originHost: string;

  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }

  if (originHost === "") return false;

  return (
    originHost === firstHeaderValue(request.headers.host) ||
    originHost === firstHeaderValue(request.headers["x-forwarded-host"])
  );
}

const make = Effect.gen(function* () {
  const bootstrapCredentials = yield* BootstrapCredentials.BootstrapCredentials;
  const sessions = yield* SessionStore.SessionStore;
  const config = yield* ServerConfig.ServerConfig;

  const authenticateToken = (
    token: string,
  ): Effect.Effect<
    AuthenticatedSession,
    ServerAuthInvalidCredentialError | ServerAuthInternalError
  > =>
    sessions.verify(token).pipe(
      Effect.tapError((cause) =>
        SessionStore.isSessionCredentialInvalidError(cause)
          ? Effect.logWarning("Rejected authenticated session credential.").pipe(
              Effect.annotateLogs({ reason: cause.message }),
            )
          : Effect.void,
      ),
      mapSessionVerificationErrors,
      Effect.map((session) => ({
        sessionId: session.sessionId,
        subject: session.subject,
        method: session.method,
        expiresAt: session.expiresAt,
      })),
    );

  // Cookies span ports; reject cookie-authenticated requests and sockets from other same-site origins.
  const trustedBrowserOrigins = new Set<string>([
    ...(config.devUrl ? [config.devUrl.origin] : []),
    ...DESKTOP_RENDERER_ORIGINS,
  ]);

  const authenticateRequest: ServerAuth["Service"]["authenticateRequest"] = (request) => {
    const credential = selectRequestCredential(request, sessions.cookieName);

    if (!credential?.token) {
      return Effect.fail(new ServerAuthMissingCredentialError({}));
    }

    if (credential.source === "cookie" && !isBrowserOriginAllowed(request, trustedBrowserOrigins)) {
      return Effect.fail(
        new ServerAuthInvalidCredentialError({
          diagnostic: "Browser sessions are only accepted from the app's own origin.",
        }),
      );
    }

    return authenticateToken(credential.token);
  };

  const getSessionState: ServerAuth["Service"]["getSessionState"] = (request) =>
    authenticateRequest(request).pipe(
      Effect.map(
        (session) =>
          ({
            authenticated: true,
            sessionMethod: session.method,
            expiresAt: session.expiresAt,
          }) satisfies AuthSessionState,
      ),
      Effect.catchIf(isServerAuthCredentialError, () =>
        Effect.succeed({ authenticated: false } satisfies AuthSessionState),
      ),
      Effect.withSpan("ServerAuth.getSessionState"),
    );

  const createBrowserSession: ServerAuth["Service"]["createBrowserSession"] = Effect.fn(
    "ServerAuth.createBrowserSession",
  )(function* (credential, previousSessionToken) {
    const previousSession =
      previousSessionToken === undefined
        ? undefined
        : yield* sessions.verify(previousSessionToken).pipe(
            Effect.catchIf(SessionStore.isSessionCredentialInvalidError, () => Effect.void),
            Effect.mapError((cause) => new ServerAuthSessionCredentialValidationError({ cause })),
          );

    const grant = yield* bootstrapCredentials
      .consume(credential)
      .pipe(Effect.mapError((cause) => new ServerAuthInvalidCredentialError({ cause })));

    const session = yield* sessions
      .issue({
        method: "browser-session-cookie",
        subject: grant.subject,
        ...(previousSession?.method === "browser-session-cookie"
          ? { replaceSessionId: previousSession.sessionId }
          : {}),
      })
      .pipe(Effect.mapError((cause) => new ServerAuthAuthenticatedSessionIssueError({ cause })));

    return {
      response: {
        authenticated: true,
        sessionMethod: session.method,
        expiresAt: session.expiresAt,
      } satisfies AuthBrowserSessionResult,
      sessionToken: session.token,
    };
  });

  const exchangeBootstrapCredential: ServerAuth["Service"]["exchangeBootstrapCredential"] =
    Effect.fn("ServerAuth.exchangeBootstrapCredential")(function* (credential) {
      const grant = yield* bootstrapCredentials
        .consume(credential)
        .pipe(Effect.mapError((cause) => new ServerAuthInvalidCredentialError({ cause })));

      const session = yield* sessions
        .issue({
          method: "bearer-access-token",
          subject: grant.subject,
          // Each desktop launch replaces the previous desktop session instead of accumulating them.
          replaceActiveForSubjectAndMethod: grant.method === "desktop-bootstrap",
        })
        .pipe(
          Effect.mapError((cause) => new ServerAuthAuthenticatedAccessTokenIssueError({ cause })),
        );

      const now = yield* DateTime.now;

      return {
        access_token: session.token,
        issued_token_type: AuthAccessTokenType,
        token_type: "Bearer",
        expires_in: Math.max(
          0,
          Math.floor((session.expiresAt.epochMilliseconds - now.epochMilliseconds) / 1000),
        ),
      } satisfies AuthAccessTokenResult;
    });

  const issueWebSocketTicket: ServerAuth["Service"]["issueWebSocketTicket"] = (session) =>
    sessions.issueWebSocketToken(session.sessionId).pipe(
      Effect.mapError((cause) => new ServerAuthWebSocketTokenIssueError({ cause })),
      Effect.map(
        (issued) =>
          ({
            ticket: issued.token,
            expiresAt: issued.expiresAt,
          }) satisfies AuthWebSocketTicketResult,
      ),
      Effect.withSpan("ServerAuth.issueWebSocketTicket"),
    );

  const issueStartupPairingUrl: ServerAuth["Service"]["issueStartupPairingUrl"] = (baseUrl) =>
    bootstrapCredentials.issueOneTimeToken.pipe(
      Effect.mapError((cause) => new ServerAuthPairingLinkCreationError({ cause })),
      Effect.map((issued) => setPairingTokenOnUrl(new URL(baseUrl), issued.credential).toString()),
      Effect.withSpan("ServerAuth.issueStartupPairingUrl"),
    );

  const authenticateWebSocketUpgrade: ServerAuth["Service"]["authenticateWebSocketUpgrade"] =
    Effect.fn("ServerAuth.authenticateWebSocketUpgrade")(function* (request) {
      const websocketTicket = Option.flatMapNullishOr(HttpServerRequest.toURL(request), (url) =>
        url.searchParams.get(WS_TICKET_QUERY_PARAM),
      ).pipe(Option.filter((value) => value.trim().length > 0));

      if (Option.isSome(websocketTicket)) {
        const session = yield* sessions
          .verifyWebSocketToken(websocketTicket.value)
          .pipe(mapSessionVerificationErrors);

        return {
          sessionId: session.sessionId,
          subject: session.subject,
          method: session.method,
          expiresAt: session.expiresAt,
        };
      }

      return yield* authenticateRequest(request);
    });

  return ServerAuth.of({
    authenticateRequest,
    authenticateWebSocketUpgrade,
    getSessionState,
    createBrowserSession,
    exchangeBootstrapCredential,
    issueWebSocketTicket,
    issueStartupPairingUrl,
  });
});

export const layer = Layer.effect(ServerAuth, make);
