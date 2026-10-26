import {
  AppHttpApi,
  AuthenticatedPrincipal,
  AuthInvalidError,
  HttpAuthentication,
  InternalError,
  SESSION_COOKIE_NAME,
} from "@app/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Cookies from "effect/http/Cookies";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ServerAuth from "./ServerAuth.ts";

// Credentials must never be cached by the browser or an intermediary.
const appendCredentialResponseHeaders = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    HttpServerResponse.setHeaders(response, { "Cache-Control": "no-store", Pragma: "no-cache" }),
  ),
);

const failInvalidCredential = () =>
  Effect.fail(new AuthInvalidError({ reason: "invalid_credential" }));

export const layerAuthentication = Layer.effect(
  HttpAuthentication,
  Effect.gen(function* () {
    const auth = yield* ServerAuth.ServerAuth;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* auth.authenticateRequest(request).pipe(
          Effect.catchTags({
            RequestCredentialError: (error) =>
              error.reason === "missing"
                ? Effect.fail(new AuthInvalidError({ reason: "missing_credential" }))
                : failInvalidCredential(),
            SessionCredentialInvalidError: failInvalidCredential,
          }),
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
        Effect.fn("http.auth.session")(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          yield* appendCredentialResponseHeaders;
          return yield* auth.getSessionState(request);
        }),
      )
      .handle(
        "browserSession",
        Effect.fn("http.auth.browserSession")(
          function* (args) {
            const result = yield* auth.createBrowserSession(args.payload.credential);
            const cookies = yield* Effect.fromResult(
              Cookies.set(Cookies.empty, SESSION_COOKIE_NAME, result.sessionToken, {
                expires: DateTime.toDate(result.response.expiresAt),
                httpOnly: true,
                path: "/",
                sameSite: "lax",
              }),
            ).pipe(Effect.mapError(() => new InternalError({ reason: "session_issuance_failed" })));
            yield* HttpEffect.appendPreResponseHandler((_request, response) =>
              Effect.succeed(HttpServerResponse.mergeCookies(response, cookies)),
            );
            yield* appendCredentialResponseHeaders;
            return result.response;
          },
          Effect.catchTags({
            BootstrapCredentialInvalidError: failInvalidCredential,
            SessionIssueError: () =>
              Effect.fail(new InternalError({ reason: "session_issuance_failed" })),
          }),
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
            BootstrapCredentialInvalidError: failInvalidCredential,
            SessionIssueError: () =>
              Effect.fail(new InternalError({ reason: "session_issuance_failed" })),
          }),
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
          Effect.catchTags({
            SessionIssueError: () =>
              Effect.fail(new InternalError({ reason: "websocket_ticket_issuance_failed" })),
          }),
        ),
      );
  }),
);
