import {
  AppHttpApi,
  AuthenticatedPrincipal,
  AuthInvalidError,
  HttpAuthentication,
  InternalError,
  SESSION_COOKIE_NAME,
  type AuthInvalidReason,
  type InternalErrorReason,
} from "@app/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Cookies from "effect/http/Cookies";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ServerAuth from "./ServerAuth.ts";

const CREDENTIAL_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

// Credentials must never be cached by the browser or an intermediary.
const appendCredentialResponseHeaders = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeaders(response, CREDENTIAL_RESPONSE_HEADERS)),
);

export const failAuthInvalid = (reason: AuthInvalidReason) =>
  Effect.fail(new AuthInvalidError({ reason }));

export const failInternal = (reason: InternalErrorReason) =>
  Effect.fail(new InternalError({ reason }));

const failCredential = (error: ServerAuth.ServerAuthCredentialError) =>
  failAuthInvalid(ServerAuth.serverAuthCredentialReason(error));

export const layerAuthentication = Layer.effect(
  HttpAuthentication,
  Effect.gen(function* () {
    const auth = yield* ServerAuth.ServerAuth;

    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;

        const session = yield* auth.authenticateRequest(request).pipe(
          Effect.catchIf(ServerAuth.isServerAuthCredentialError, failCredential),
          Effect.catchIf(ServerAuth.isServerAuthInternalError, () =>
            failInternal("internal_error"),
          ),
        );

        return yield* httpEffect.pipe(Effect.provideService(AuthenticatedPrincipal, session));
      });
  }),
);

export const layer = HttpApiBuilder.group(
  AppHttpApi,
  "auth",
  Effect.fnUntraced(function* (handlers) {
    const auth = yield* ServerAuth.ServerAuth;

    return handlers
      .handle(
        "session",
        Effect.fn("http.auth.session")(
          function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            yield* appendCredentialResponseHeaders;

            return yield* auth.getSessionState(request);
          },
          Effect.catchIf(ServerAuth.isServerAuthInternalError, () =>
            failInternal("internal_error"),
          ),
        ),
      )
      .handle(
        "browserSession",
        Effect.fn("http.auth.browserSession")(
          function* (args) {
            const request = yield* HttpServerRequest.HttpServerRequest;

            const previousCredential = ServerAuth.selectRequestCredential(
              request,
              SESSION_COOKIE_NAME,
            );

            const result = yield* auth.createBrowserSession(
              args.payload.credential,
              previousCredential?.source === "cookie" ? previousCredential.token : undefined,
            );

            const cookies = yield* Effect.fromResult(
              Cookies.set(Cookies.empty, SESSION_COOKIE_NAME, result.sessionToken, {
                expires: DateTime.toDate(result.response.expiresAt),
                httpOnly: true,
                path: "/",
                sameSite: "lax",
              }),
            ).pipe(Effect.catch(() => failInternal("session_issuance_failed")));

            yield* HttpEffect.appendPreResponseHandler((_request, response) =>
              Effect.succeed(HttpServerResponse.mergeCookies(response, cookies)),
            );
            yield* appendCredentialResponseHeaders;

            return result.response;
          },
          Effect.catchTags({
            ServerAuthInvalidCredentialError: () => failAuthInvalid("invalid_credential"),
          }),
          Effect.catchIf(ServerAuth.isServerAuthInternalError, () =>
            failInternal("session_issuance_failed"),
          ),
        ),
      )
      .handle(
        "token",
        Effect.fn("http.auth.token")(
          function* (args) {
            yield* appendCredentialResponseHeaders;

            return yield* auth.exchangeBootstrapCredential(args.payload.subject_token);
          },
          Effect.catchTags({
            ServerAuthInvalidCredentialError: () => failAuthInvalid("invalid_credential"),
          }),
          Effect.catchIf(ServerAuth.isServerAuthInternalError, () =>
            failInternal("session_issuance_failed"),
          ),
        ),
      )
      .handle(
        "webSocketTicket",
        Effect.fn("http.auth.webSocketTicket")(
          function* () {
            const session = yield* AuthenticatedPrincipal;
            yield* appendCredentialResponseHeaders;

            return yield* auth.issueWebSocketTicket(session);
          },
          Effect.catchIf(ServerAuth.isServerAuthInternalError, () =>
            failInternal("websocket_ticket_issuance_failed"),
          ),
        ),
      );
  }),
);
