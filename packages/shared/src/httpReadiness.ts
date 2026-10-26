import type * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient, type HttpClientError } from "effect/http";

export class HttpReadinessError extends Schema.TaggedError<HttpReadinessError>()(
  "HttpReadinessError",
  {
    requestUrl: Schema.String,
    timeout: Schema.Duration,
    attempts: Schema.Number,
    /** The last probe's failure, absent when no probe finished in time. */
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `${this.requestUrl} did not answer after ${this.attempts} attempts in ${Duration.format(this.timeout)}.`;
  }
}

/** Probes `path` until it answers with a 2xx status, retrying failed and slow probes until `timeout`. */
export const waitForHttpReady = Effect.fn("shared.httpReadiness.waitForHttpReady")(
  function* (input: {
    readonly baseUrl: URL;
    readonly path: string;
    readonly timeout: Duration.Duration;
    readonly interval: Duration.Duration;
    readonly probeTimeout: Duration.Duration;
  }) {
    const requestUrl = new URL(input.path, input.baseUrl).href;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const attempts = yield* Ref.make(0);

    const lastFailure = yield* Ref.make(
      Option.none<HttpClientError.HttpClientError | Cause.TimeoutError>(),
    );

    const probe = Ref.update(attempts, (count) => count + 1).pipe(
      Effect.andThen(client.get(requestUrl)),
      // Reading the body releases the connection for the next probe.
      Effect.tap((response) => response.text.pipe(Effect.ignore)),
      Effect.timeout(input.probeTimeout),
      Effect.tapError((error) =>
        Ref.set(lastFailure, Option.some(error)).pipe(Effect.andThen(Effect.sleep(input.interval))),
      ),
    );

    yield* probe.pipe(
      Effect.eventually,
      Effect.timeoutOrElse({
        duration: input.timeout,
        orElse: Effect.fnUntraced(function* () {
          return yield* new HttpReadinessError({
            requestUrl,
            timeout: input.timeout,
            attempts: yield* Ref.get(attempts),
            cause: Option.getOrUndefined(yield* Ref.get(lastFailure)),
          });
        }),
      }),
    );
    yield* Effect.logDebug("httpReadiness.ready", {
      requestUrl,
      attempts: yield* Ref.get(attempts),
    });
  },
);
