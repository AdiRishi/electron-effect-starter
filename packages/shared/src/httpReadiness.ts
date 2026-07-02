import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

export const DEFAULT_HTTP_READY_PROBE_TIMEOUT_MS = 1_000;

/**
 * Generic HTTP readiness probe. Polls `baseUrl + path` until it returns a 2xx
 * or the overall `timeoutMs` elapses. Each probe is bounded by `probeTimeoutMs`
 * so one hung request can't stall the loop. The error type is left to the
 * caller via `makeError` so each consumer keeps its own tagged error.
 *
 * The shell uses this to wait for the spawned server to come up before showing
 * the window.
 */
export const waitForHttpReady = Effect.fn("shared.httpReadiness.waitForHttpReady")(function* <
  E,
>(input: {
  readonly baseUrl: string;
  readonly path?: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly probeTimeoutMs?: number;
  readonly makeError: (info: {
    readonly requestUrl: string;
    readonly attempt: number;
    readonly cause: unknown;
  }) => E;
}): Effect.fn.Return<void, E, HttpClient.HttpClient> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const intervalMs = input.intervalMs ?? 100;
  const probeTimeoutMs = input.probeTimeoutMs ?? DEFAULT_HTTP_READY_PROBE_TIMEOUT_MS;
  const retryPolicy = Schedule.spaced(Duration.millis(intervalMs)).pipe(
    Schedule.take(Math.max(0, Math.ceil(timeoutMs / intervalMs))),
  );
  const requestUrl = new URL(input.path ?? "/", input.baseUrl).toString();
  const client = yield* HttpClient.HttpClient;
  const lastProbeFailure = yield* Ref.make<unknown>(null);
  let attempt = 0;

  const makeError = input.makeError;
  const madeErrors = new WeakSet<object>();
  const fail = (cause: unknown): E => {
    const error = makeError({ requestUrl, attempt, cause });
    if (typeof error === "object" && error !== null) madeErrors.add(error);
    return error;
  };
  const isMadeError = (value: unknown): value is E =>
    typeof value === "object" && value !== null && madeErrors.has(value);

  const readinessClient = client.pipe(
    HttpClient.filterStatusOk,
    HttpClient.transform((effect) =>
      Effect.gen(function* () {
        attempt += 1;
        const responseOption = yield* effect.pipe(
          Effect.timeoutOption(Duration.millis(probeTimeoutMs)),
          Effect.mapError((cause) => fail(cause)),
        );
        return yield* Option.match(responseOption, {
          onSome: Effect.succeed,
          onNone: () => Effect.fail(fail({ kind: "probe-timeout", attempt })),
        });
      }).pipe(
        Effect.mapError((cause) => (isMadeError(cause) ? cause : fail(cause))),
        Effect.tapError((cause) => Ref.set(lastProbeFailure, { attempt, cause })),
      ),
    ),
    HttpClient.tap((response) => response.text.pipe(Effect.ignore)),
    HttpClient.retry(retryPolicy),
  );

  const result = yield* readinessClient.execute(HttpClientRequest.get(requestUrl)).pipe(
    Effect.mapError((cause) => (isMadeError(cause) ? cause : fail(cause))),
    Effect.timeoutOption(Duration.millis(timeoutMs)),
  );

  return yield* Option.match(result, {
    onSome: () => Effect.void,
    onNone: () =>
      Effect.gen(function* () {
        const lastFailure = yield* Ref.get(lastProbeFailure);
        return yield* Effect.fail(
          fail({
            kind: "overall-timeout",
            baseUrl: input.baseUrl,
            timeoutMs,
            lastFailure,
          }),
        );
      }),
  });
});
