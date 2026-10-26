import {
  AppHttpApi,
  AuthenticatedPrincipal,
  AuthInvalidError,
  HttpAuthentication,
  InternalError,
  type AuthInvalidReason,
  type InternalErrorReason,
} from "@app/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Cookies from "effect/http/Cookies";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ServerAuth from "./ServerAuth.ts";
import * as SessionStore from "./SessionStore.ts";

const CREDENTIAL_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

// Credentials must never be cached by the browser or an intermediary.
const appendCredentialResponseHeaders = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeaders(response, CREDENTIAL_RESPONSE_HEADERS)),
);

const currentTraceId = Effect.currentParentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => "unavailable"),
);

const isStructuralTag = (value: unknown): value is string =>
  Predicate.isString(value) &&
  value.length > 0 &&
  value.length <= 128 &&
  /^[A-Za-z][A-Za-z0-9._:/-]*$/.test(value);

/** The tag of a cause's first failure, safe to log: never the error's own message or payload. */
function causeErrorTag(cause: Cause.Cause<unknown>): string {
  const failure = Cause.findErrorOption(cause);

  if (Option.isSome(failure)) {
    const error = failure.value;

    if (Predicate.hasProperty(error, "_tag")) {
      return isStructuralTag(error._tag) ? error._tag : "TaggedError";
    }

    if (error instanceof Error) return isStructuralTag(error.name) ? error.name : "Error";

    return "UnknownError";
  }

  return cause.reasons[0]?._tag ?? "Empty";
}

/** Tags the request's logs and span with the endpoint and trace id. */
export const annotateRequest =
  /* Request instrumentation already owns the span; keep this helper in that context. */
  Effect.fnUntraced(function* (endpoint: string) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const traceId = yield* currentTraceId;
    yield* Effect.annotateLogsScoped({ "http.endpoint": endpoint, traceId });
    yield* Effect.annotateCurrentSpan({
      "http.endpoint": endpoint,
      "http.request.method": request.method,
      "url.path": Option.isSome(url) ? url.value.pathname : "unknown",
    });
  });

/**
 * Logs a handler that fails. Runs as the last step of a handler: HttpApiBuilder turns the error
 * into a response before the request scope closes, so a scope finalizer never sees the failure.
 */
export const logFailedRequest = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  args: { readonly endpoint: { readonly identifier: string } },
) =>
  effect.pipe(
    Effect.tapCause((cause) =>
      currentTraceId.pipe(
        Effect.flatMap((traceId) =>
          Effect.logWarning("api request failed", {
            endpoint: args.endpoint.identifier,
            traceId,
            errorTag: causeErrorTag(cause),
            cause,
          }),
        ),
      ),
    ),
  );

export const failAuthInvalid = (reason: AuthInvalidReason) =>
  Effect.fail(new AuthInvalidError({ reason }));

export const failInternal =
  /* Request instrumentation already owns the span; keep this helper in that context. */
  Effect.fnUntraced(function* (reason: InternalErrorReason, error?: Error) {
    if (error !== undefined) {
      yield* Effect.logError("api operation failed", {
        reason,
        traceId: yield* currentTraceId,
        cause: error,
      });
    }

    return yield* new InternalError({ reason });
  });

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
          Effect.catchIf(ServerAuth.isServerAuthInternalError, (error) =>
            failInternal("internal_error", error),
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
    const sessions = yield* SessionStore.SessionStore;

    return handlers
      .handle(
        "session",
        Effect.fn("http.auth.session")(
          function* (args) {
            yield* annotateRequest(args.endpoint.identifier);
            const request = yield* HttpServerRequest.HttpServerRequest;
            yield* appendCredentialResponseHeaders;

            return yield* auth.getSessionState(request);
          },
          Effect.catchIf(ServerAuth.isServerAuthInternalError, (error) =>
            failInternal("internal_error", error),
          ),
          logFailedRequest,
        ),
      )
      .handle(
        "browserSession",
        Effect.fn("http.auth.browserSession")(
          function* (args) {
            yield* annotateRequest(args.endpoint.identifier);
            const request = yield* HttpServerRequest.HttpServerRequest;

            const previousCredential = ServerAuth.selectRequestCredential(
              request,
              sessions.cookieName,
            );

            const result = yield* auth.createBrowserSession(
              args.payload.credential,
              previousCredential?.source === "cookie" ? previousCredential.token : undefined,
            );

            const cookies = yield* Effect.fromResult(
              Cookies.set(Cookies.empty, sessions.cookieName, result.sessionToken, {
                expires: DateTime.toDate(result.response.expiresAt),
                httpOnly: true,
                path: "/",
                sameSite: "lax",
              }),
            ).pipe(Effect.catch((error) => failInternal("session_issuance_failed", error)));

            yield* HttpEffect.appendPreResponseHandler((_request, response) =>
              Effect.succeed(HttpServerResponse.mergeCookies(response, cookies)),
            );
            yield* appendCredentialResponseHeaders;

            return result.response;
          },
          Effect.catchTags({
            ServerAuthInvalidCredentialError: () => failAuthInvalid("invalid_credential"),
          }),
          Effect.catchIf(ServerAuth.isServerAuthInternalError, (error) =>
            failInternal("session_issuance_failed", error),
          ),
          logFailedRequest,
        ),
      )
      .handle(
        "token",
        Effect.fn("http.auth.token")(
          function* (args) {
            yield* annotateRequest(args.endpoint.identifier);
            yield* appendCredentialResponseHeaders;

            return yield* auth.exchangeBootstrapCredential(args.payload.subject_token);
          },
          Effect.catchTags({
            ServerAuthInvalidCredentialError: () => failAuthInvalid("invalid_credential"),
          }),
          Effect.catchIf(ServerAuth.isServerAuthInternalError, (error) =>
            failInternal("session_issuance_failed", error),
          ),
          logFailedRequest,
        ),
      )
      .handle(
        "webSocketTicket",
        Effect.fn("http.auth.webSocketTicket")(
          function* (args) {
            yield* annotateRequest(args.endpoint.identifier);
            const session = yield* AuthenticatedPrincipal;
            yield* appendCredentialResponseHeaders;

            return yield* auth.issueWebSocketTicket(session);
          },
          Effect.catchIf(ServerAuth.isServerAuthInternalError, (error) =>
            failInternal("websocket_ticket_issuance_failed", error),
          ),
          logFailedRequest,
        ),
      );
  }),
);
