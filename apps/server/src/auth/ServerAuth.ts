import {
  AuthAccessTokenType,
  PAIRING_TOKEN_QUERY_PARAM,
  SESSION_COOKIE_NAME,
  WS_TICKET_QUERY_PARAM,
  type AuthAccessTokenResult,
  type AuthBrowserSessionResult,
  type AuthSessionState,
  type AuthWebSocketTicketResult,
} from "@app/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpServerRequest } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as BootstrapCredentials from "./BootstrapCredentials.ts";
import * as SessionStore from "./SessionStore.ts";

const BEARER_PREFIX = "Bearer ";

type RequestCredential = { readonly token: string; readonly source: "cookie" | "bearer" };

function selectRequestCredential(
  request: HttpServerRequest.HttpServerRequest,
): RequestCredential | undefined {
  const cookieToken = request.cookies[SESSION_COOKIE_NAME];
  if (cookieToken !== undefined && cookieToken.length > 0) {
    return { token: cookieToken, source: "cookie" };
  }
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith(BEARER_PREFIX)) {
    const token = header.slice(BEARER_PREFIX.length).trim();
    if (token.length > 0) return { token, source: "bearer" };
  }
  return undefined;
}

function firstHeaderValue(value: string | undefined): string | undefined {
  const first = value?.split(",")[0]?.trim().toLowerCase();
  return first && first.length > 0 ? first : undefined;
}

// Cookies span ports on the same host, so a cookie-authenticated request must come from this
// server's own origin or a trusted dev origin. A missing Origin is a same-origin read.
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
  return originHost !== "" && originHost === firstHeaderValue(request.headers.host);
}

export class RequestCredentialError extends Schema.TaggedError<RequestCredentialError>()(
  "RequestCredentialError",
  { reason: Schema.Literals(["missing", "untrusted_origin"]) },
) {
  override get message(): string {
    return this.reason === "missing"
      ? "The request carries no session credential."
      : "Browser sessions are only accepted from the app's own origin.";
  }
}

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
    ) => Effect.Effect<
      SessionStore.Session,
      SessionStore.SessionCredentialInvalidError | RequestCredentialError
    >;
    readonly authenticateWebSocketUpgrade: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<
      SessionStore.Session,
      SessionStore.SessionCredentialInvalidError | RequestCredentialError
    >;
    readonly getSessionState: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<AuthSessionState>;
    readonly createBrowserSession: (
      credential: string,
    ) => Effect.Effect<
      { readonly response: AuthBrowserSessionResult; readonly sessionToken: string },
      BootstrapCredentials.BootstrapCredentialInvalidError | SessionStore.SessionIssueError
    >;
    readonly exchangeBootstrapCredential: (
      credential: string,
    ) => Effect.Effect<
      AuthAccessTokenResult,
      BootstrapCredentials.BootstrapCredentialInvalidError | SessionStore.SessionIssueError
    >;
    readonly issueWebSocketTicket: (
      session: SessionStore.Session,
    ) => Effect.Effect<AuthWebSocketTicketResult, SessionStore.SessionIssueError>;
    readonly issueStartupPairingUrl: (
      baseUrl: string,
    ) => Effect.Effect<string, BootstrapCredentials.PairingTokenIssueError>;
  }
>()("@app/server/auth/ServerAuth") {}

const make = Effect.gen(function* () {
  const sessions = yield* SessionStore.SessionStore;
  const bootstrapCredentials = yield* BootstrapCredentials.BootstrapCredentials;
  const config = yield* ServerConfig.ServerConfig;
  const trustedOrigins = new Set<string>(config.devUrl ? [config.devUrl.origin] : []);

  const authenticateRequest: ServerAuth["Service"]["authenticateRequest"] = (request) => {
    const credential = selectRequestCredential(request);
    if (credential === undefined) {
      return Effect.fail(new RequestCredentialError({ reason: "missing" }));
    }
    if (credential.source === "cookie" && !isBrowserOriginAllowed(request, trustedOrigins)) {
      return Effect.fail(new RequestCredentialError({ reason: "untrusted_origin" }));
    }
    return sessions.verify(credential.token);
  };

  const authenticateWebSocketUpgrade = Effect.fn("ServerAuth.authenticateWebSocketUpgrade")(
    function* (request: HttpServerRequest.HttpServerRequest) {
      const ticket = Option.flatMapNullishOr(HttpServerRequest.toURL(request), (url) =>
        url.searchParams.get(WS_TICKET_QUERY_PARAM),
      ).pipe(Option.filter((value) => value.trim().length > 0));
      return Option.isSome(ticket)
        ? yield* sessions.verifyWebSocketTicket(ticket.value)
        : yield* authenticateRequest(request);
    },
  );

  const getSessionState: ServerAuth["Service"]["getSessionState"] = (request) =>
    authenticateRequest(request).pipe(
      Effect.map((session): AuthSessionState => ({
        authenticated: true,
        sessionMethod: session.method,
        expiresAt: session.expiresAt,
      })),
      Effect.orElseSucceed((): AuthSessionState => ({ authenticated: false })),
      Effect.withSpan("ServerAuth.getSessionState"),
    );

  const createBrowserSession = Effect.fn("ServerAuth.createBrowserSession")(function* (
    credential: string,
  ) {
    yield* bootstrapCredentials.consume(credential);
    const session = yield* sessions.issue({ method: "browser-session-cookie" });
    return {
      response: {
        authenticated: true,
        sessionMethod: session.method,
        expiresAt: session.expiresAt,
      } satisfies AuthBrowserSessionResult,
      sessionToken: session.token,
    };
  });

  const exchangeBootstrapCredential = Effect.fn("ServerAuth.exchangeBootstrapCredential")(
    function* (credential: string) {
      yield* bootstrapCredentials.consume(credential);
      const session = yield* sessions.issue({ method: "bearer-access-token" });
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
    },
  );

  const issueWebSocketTicket = Effect.fn("ServerAuth.issueWebSocketTicket")(function* (
    session: SessionStore.Session,
  ) {
    const issued = yield* sessions.issueWebSocketTicket(session);
    return {
      ticket: issued.ticket,
      expiresAt: issued.expiresAt,
    } satisfies AuthWebSocketTicketResult;
  });

  // The token travels in the fragment so it never reaches server logs or a Referer header.
  const issueStartupPairingUrl = Effect.fn("ServerAuth.issueStartupPairingUrl")(function* (
    baseUrl: string,
  ) {
    const { token } = yield* bootstrapCredentials.issuePairingToken;
    const url = new URL(baseUrl);
    url.hash = new URLSearchParams([[PAIRING_TOKEN_QUERY_PARAM, token]]).toString();
    return url.toString();
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
