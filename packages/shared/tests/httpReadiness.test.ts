import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { describeReadinessCause, waitForHttpReady } from "../src/httpReadiness.ts";

const hangingHttpClient = HttpClient.make(() => Effect.never);

it.effect("retries unsuccessful responses until the server is ready", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const client = HttpClient.make((request) =>
      Ref.updateAndGet(attempts, (attempt) => attempt + 1).pipe(
        Effect.map((attempt) =>
          HttpClientResponse.fromWeb(
            request,
            new Response(null, { status: attempt < 3 ? 503 : 204 }),
          ),
        ),
      ),
    );

    const fiber = yield* waitForHttpReady({
      baseUrl: "http://readiness.test",
      timeoutMs: 1_000,
      intervalMs: 100,
      probeTimeoutMs: 50,
      makeError: ({ cause }) => new Error("Readiness probe failed", { cause }),
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.forkChild({ startImmediately: true }),
    );

    yield* TestClock.adjust("200 millis");
    yield* Fiber.join(fiber);

    assert.equal(yield* Ref.get(attempts), 3);
  }),
);

it.effect("bounds each HTTP readiness probe so retries cannot hang on one request", () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(
      Effect.result(
        waitForHttpReady({
          baseUrl: "http://127.0.0.1:41773/",
          timeoutMs: 1_000,
          intervalMs: 100,
          probeTimeoutMs: 250,
          makeError: ({ cause }) => new Error("Readiness probe failed", { cause }),
        }),
      ),
      { startImmediately: true },
    );
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(1_000));

    const result = yield* Fiber.join(fiber);

    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      assert.equal(result.failure.message, "Readiness probe failed");
      const cause = result.failure.cause as { readonly kind?: string; readonly timeoutMs?: number };
      assert.equal(cause.kind, "overall-timeout");
      assert.equal(cause.timeoutMs, 1_000);
    }
  }).pipe(Effect.provideService(HttpClient.HttpClient, hangingHttpClient)),
);

it("preserves primitive readiness reason values in diagnostic output", () => {
  assert.deepEqual(
    describeReadinessCause({
      _tag: "HttpClientError",
      message: "Backend readiness probe failed.",
      reason: "authentication failed",
      cause: "upstream closed",
    }),
    {
      _tag: "HttpClientError",
      message: "Backend readiness probe failed.",
      reason: "authentication failed",
      cause: "upstream closed",
    },
  );
});
