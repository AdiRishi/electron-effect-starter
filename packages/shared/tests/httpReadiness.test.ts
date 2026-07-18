import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { waitForHttpReady } from "../src/httpReadiness.ts";

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
