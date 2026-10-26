import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import { waitForHttpReady } from "../src/httpReadiness.ts";

const probeOptions = {
  baseUrl: new URL("http://127.0.0.1:3773"),
  path: "/ready",
  timeout: Duration.seconds(5),
  interval: Duration.millis(100),
  probeTimeout: Duration.seconds(1),
};

// The server is the external seam: each probe gets the next scripted answer, and the last repeats.
const layerServer = (answers: ReadonlyArray<number | "hang">) =>
  Layer.sync(HttpClient.HttpClient, () => {
    let probes = 0;
    return HttpClient.make((request) => {
      const answer = answers[Math.min(probes, answers.length - 1)];
      probes += 1;
      return answer === "hang" || answer === undefined
        ? Effect.never
        : Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(null, { status: answer })),
          );
    });
  });

describe("waitForHttpReady", () => {
  it.effect("resolves once the endpoint answers with a 2xx status", () =>
    Effect.gen(function* () {
      const fiber = yield* waitForHttpReady(probeOptions).pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(200));
      yield* Fiber.join(fiber);
    }).pipe(Effect.provide(layerServer([503, 503, 200]))),
  );

  it.effect("fails with the last bad status once the timeout passes", () =>
    Effect.gen(function* () {
      const fiber = yield* waitForHttpReady(probeOptions).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(probeOptions.timeout);
      const error = yield* Fiber.join(fiber);
      assert.strictEqual(error.requestUrl, "http://127.0.0.1:3773/ready");
      assert.isTrue(HttpClientError.isHttpClientError(error.cause));
      assert.strictEqual(
        HttpClientError.isHttpClientError(error.cause) ? error.cause.reason._tag : undefined,
        "StatusCodeError",
      );
    }).pipe(Effect.provide(layerServer([503]))),
  );

  it.effect("treats a probe that never answers as a failure and reports its timeout", () =>
    Effect.gen(function* () {
      const fiber = yield* waitForHttpReady(probeOptions).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(probeOptions.timeout);
      const error = yield* Fiber.join(fiber);
      assert.isTrue(Cause.isTimeoutError(error.cause));
    }).pipe(Effect.provide(layerServer(["hang"]))),
  );
});
