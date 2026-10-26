import { AuthAccessTokenResult, AuthAccessTokenType, AuthInvalidError } from "@app/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http";

import * as DesktopBackend from "../../src/backend/DesktopBackend.ts";
import * as DesktopServerAuth from "../../src/backend/DesktopServerAuth.ts";

const encodeTokenResult = Schema.encodeSync(Schema.fromJsonString(AuthAccessTokenResult));
const encodeAuthInvalid = Schema.encodeSync(Schema.fromJsonString(AuthInvalidError));

const tokenResponse = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(
      encodeTokenResult({
        access_token: "desktop-bearer-token",
        issued_token_type: AuthAccessTokenType,
        token_type: "Bearer",
        expires_in: 3600,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );

const layerBackend = Layer.succeed(
  DesktopBackend.DesktopBackend,
  DesktopBackend.DesktopBackend.of({
    start: () => Effect.void,
    restart: Effect.void,
    stop: () => Effect.void,
    snapshot: Effect.succeed({
      desiredRunning: true,
      ready: true,
      activePid: Option.none(),
      restartAttempt: 0,
      restartScheduled: false,
    }),
    bootstrapToken: "desktop-bootstrap-token",
    rendererBootstrap: Effect.succeed({
      httpBaseUrl: "http://127.0.0.1:3773/",
      wsBaseUrl: "ws://127.0.0.1:3773/",
    }),
  }),
);

// The server is the external seam: the fake answers the first `failures` requests with `failure`.
const makeExchange = (failures: number, failure: () => Response) =>
  Effect.gen(function* () {
    const requestCount = yield* Ref.make(0);

    const layerHttpClient = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Ref.updateAndGet(requestCount, (count) => count + 1).pipe(
          Effect.map((count) =>
            count <= failures
              ? HttpClientResponse.fromWeb(request, failure())
              : tokenResponse(request),
          ),
        ),
      ),
    );

    const auth = yield* DesktopServerAuth.DesktopServerAuth.pipe(
      Effect.provide(
        DesktopServerAuth.layer.pipe(Layer.provide(Layer.mergeAll(layerBackend, layerHttpClient))),
      ),
    );

    return { auth, requestCount };
  });

describe("DesktopServerAuth", () => {
  it.effect("exchanges the desktop bootstrap credential only once", () =>
    Effect.gen(function* () {
      const { auth, requestCount } = yield* makeExchange(0, () => new Response());

      const [first, second] = yield* Effect.all([auth.getBearerToken, auth.getBearerToken], {
        concurrency: "unbounded",
      });

      assert.strictEqual(first, "desktop-bearer-token");
      assert.strictEqual(second, "desktop-bearer-token");
      assert.strictEqual(yield* Ref.get(requestCount), 1);
    }),
  );

  it.effect("does not retry a rejected bootstrap credential", () =>
    Effect.gen(function* () {
      const { auth, requestCount } = yield* makeExchange(
        1,
        () =>
          new Response(encodeAuthInvalid(new AuthInvalidError({ reason: "invalid_credential" })), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
      );

      const fiber = yield* auth.getBearerToken.pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(Duration.seconds(1));
      const error = yield* Fiber.join(fiber);

      assert.strictEqual(error.reason, "exchange-failed");
      assert.strictEqual(yield* Ref.get(requestCount), 1);
    }),
  );

  it.effect("asks a restarting server again until it answers", () =>
    Effect.gen(function* () {
      const { auth, requestCount } = yield* makeExchange(
        2,
        () => new Response(null, { status: 503 }),
      );

      const fiber = yield* auth.getBearerToken.pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.seconds(1));

      assert.strictEqual(yield* Fiber.join(fiber), "desktop-bearer-token");
      assert.strictEqual(yield* Ref.get(requestCount), 3);
    }),
  );

  it.effect("does not retry a server error that is not transient", () =>
    Effect.gen(function* () {
      const { auth, requestCount } = yield* makeExchange(
        1,
        () => new Response(null, { status: 500 }),
      );

      const fiber = yield* auth.getBearerToken.pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* Fiber.join(fiber);

      assert.strictEqual(yield* Ref.get(requestCount), 1);
    }),
  );
});
