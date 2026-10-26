import {
  AppHttpApi,
  AuthAccessTokenType,
  AuthBootstrapTokenType,
  AuthTokenExchangeGrantType,
} from "@app/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Cause from "effect/Cause";
import { HttpClient, HttpClientError } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as DesktopBackend from "./DesktopBackend.ts";

// The renderer asks right after the window opens; a server that just restarted answers 503 briefly.
const TRANSIENT_RETRY_TIMEOUT = Duration.seconds(15);
const TRANSIENT_RETRY_INTERVAL = Duration.millis(500);
const REQUEST_TIMEOUT = Duration.seconds(10);
const TRANSIENT_STATUS_CODES = new Set([502, 503, 504]);

// A rejected or malformed exchange fails the same way on every attempt, so only an unreachable,
// slow or restarting server is worth asking again.
const isTransientExchangeError = <E>(error: E): boolean => {
  if (Cause.isTimeoutError(error)) return true;

  if (!HttpClientError.isHttpClientError(error)) return false;

  return (
    Predicate.isTagged(error.reason, "TransportError") ||
    TRANSIENT_STATUS_CODES.has(error.response?.status ?? 0)
  );
};

export class DesktopServerAuthError extends Schema.TaggedError<DesktopServerAuthError>()(
  "DesktopServerAuthError",
  {
    reason: Schema.Literals(["not-started", "exchange-failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "not-started"
      ? "The local server has not started."
      : "Failed to create a bearer session with the local server.";
  }
}

/** Trades the launch's bootstrap token for one bearer token and hands it to the renderer. */
export class DesktopServerAuth extends Context.Service<
  DesktopServerAuth,
  { readonly getBearerToken: Effect.Effect<string, DesktopServerAuthError> }
>()("@app/desktop/backend/DesktopServerAuth") {}

const make = Effect.gen(function* () {
  const backend = yield* DesktopBackend.DesktopBackend;
  const httpClient = yield* HttpClient.HttpClient;
  const token = yield* Ref.make(Option.none<string>());
  const mutex = yield* Semaphore.make(1);

  const exchange = Effect.gen(function* () {
    const bootstrap = yield* backend.rendererBootstrap;

    if (bootstrap === null) return yield* new DesktopServerAuthError({ reason: "not-started" });
    const client = yield* HttpApiClient.make(AppHttpApi, { baseUrl: bootstrap.httpBaseUrl });

    const result = yield* client.auth
      .token({
        payload: {
          grant_type: AuthTokenExchangeGrantType,
          subject_token: backend.bootstrapToken,
          subject_token_type: AuthBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
        },
      })
      .pipe(
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.retry({
          while: isTransientExchangeError,
          schedule: Schedule.spaced(TRANSIENT_RETRY_INTERVAL),
        }),
        Effect.timeout(TRANSIENT_RETRY_TIMEOUT),
        Effect.mapError(
          (cause) => new DesktopServerAuthError({ reason: "exchange-failed", cause }),
        ),
      );

    return result.access_token;
  }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

  const getBearerToken = mutex.withPermits(1)(
    Effect.gen(function* () {
      const cached = yield* Ref.get(token);

      if (Option.isSome(cached)) return cached.value;
      const issued = yield* exchange;
      yield* Ref.set(token, Option.some(issued));

      return issued;
    }),
  );

  return DesktopServerAuth.of({
    getBearerToken: getBearerToken.pipe(Effect.withSpan("DesktopServerAuth.getBearerToken")),
  });
});

export const layer = Layer.effect(DesktopServerAuth, make);
