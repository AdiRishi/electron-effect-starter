import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import {
  AuthAccessTokenResult,
  AuthBrowserSessionRequest,
  AuthBrowserSessionResult,
  AuthSessionState,
  AuthTokenExchangeRequest,
  AuthWebSocketTicketResult,
  type ServerAuthSessionMethod,
} from "./auth.ts";
import type { AuthSessionId } from "./baseSchemas.ts";
import { ServerDescriptor } from "./server.ts";

/** The desktop shell polls this path to learn the server is serving. */
export const SERVER_DESCRIPTOR_PATH = "/.well-known/app/server";

const OptionalBearerHeaders = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
});

export const AuthInvalidReason = Schema.Literals(["missing_credential", "invalid_credential"]);

export type AuthInvalidReason = typeof AuthInvalidReason.Type;

export class AuthInvalidError extends Schema.TaggedError<AuthInvalidError>()(
  "AuthInvalidError",
  { reason: AuthInvalidReason },
  { httpApiStatus: 401 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(AuthInvalidError)(this, { status: 401 });
  }

  override get message(): string {
    return `The server rejected this client's credentials (${this.reason}).`;
  }
}

export const InternalErrorReason = Schema.Literals([
  "session_issuance_failed",
  "websocket_ticket_issuance_failed",
]);

export type InternalErrorReason = typeof InternalErrorReason.Type;

export class InternalError extends Schema.TaggedError<InternalError>()(
  "InternalError",
  { reason: InternalErrorReason },
  { httpApiStatus: 500 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(InternalError)(this, { status: 500 });
  }

  override get message(): string {
    return `The server failed to answer this request (${this.reason}).`;
  }
}

export class AuthenticatedPrincipal extends Context.Service<
  AuthenticatedPrincipal,
  {
    readonly sessionId: AuthSessionId;
    readonly method: ServerAuthSessionMethod;
    readonly expiresAt: DateTime.Utc;
  }
>()("@app/contracts/http/AuthenticatedPrincipal") {}

export class HttpAuthentication extends HttpApiMiddleware.Service<
  HttpAuthentication,
  { provides: AuthenticatedPrincipal }
>()("HttpAuthentication", {
  error: [AuthInvalidError, InternalError],
}) {}

export class MetadataHttpApi extends HttpApiGroup.make("metadata").add(
  HttpApiEndpoint.get("descriptor", SERVER_DESCRIPTOR_PATH, {
    success: ServerDescriptor,
  }),
) {}

export class AuthHttpApi extends HttpApiGroup.make("auth")
  .add(
    HttpApiEndpoint.get("session", "/api/auth/session", {
      headers: OptionalBearerHeaders,
      success: AuthSessionState,
    }),
  )
  .add(
    HttpApiEndpoint.post("browserSession", "/api/auth/browser-session", {
      payload: AuthBrowserSessionRequest,
      success: AuthBrowserSessionResult,
      error: [AuthInvalidError, InternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("token", "/oauth/token", {
      payload: AuthTokenExchangeRequest,
      success: AuthAccessTokenResult,
      error: [AuthInvalidError, InternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("webSocketTicket", "/api/auth/websocket-ticket", {
      headers: OptionalBearerHeaders,
      success: AuthWebSocketTicketResult,
      error: [InternalError],
    }).middleware(HttpAuthentication),
  ) {}

export class AppHttpApi extends HttpApi.make("app").add(MetadataHttpApi).add(AuthHttpApi) {}
