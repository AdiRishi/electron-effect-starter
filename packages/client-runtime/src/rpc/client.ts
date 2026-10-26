import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as RpcClientError from "effect/rpc/RpcClientError";

import * as ConnectionSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "./protocol.ts";

export class RpcUnavailableError extends Schema.TaggedError<RpcUnavailableError>()(
  "RpcUnavailableError",
  {},
) {
  override get message(): string {
    return "The server is not connected.";
  }
}

const isRpcClientError = Schema.is(RpcClientError.RpcClientError);
const isRpcClientDefect = Schema.is(RpcClientError.RpcClientDefect);

/** Runs one request on the live session, failing at once when there is none. */
export const withClient = Effect.fn("RpcClient.withClient")(function* <A, E, R>(
  f: (client: WsRpcProtocolClient) => Effect.Effect<A, E, R>,
) {
  const supervisor = yield* ConnectionSupervisor.ConnectionSupervisor;
  const session = yield* SubscriptionRef.get(supervisor.session);

  if (Option.isNone(session)) return yield* new RpcUnavailableError();

  return yield* f(session.value.client);
});

const MAX_EXPECTED_FAILURE_RETRY_DELAY_MS = 30_000;

export interface FollowSessionOptions<E> {
  /** Sees every cause that holds a defect, before the defect ends the stream. */
  readonly onDefect?: (cause: Cause.Cause<E>) => Effect.Effect<void>;
  /**
   * Handles a cause made only of typed failures. The stream then waits for the next session, or
   * resubscribes after `retryExpectedFailureAfter`, doubling up to 30 seconds. Without it, the
   * failure ends the stream.
   */
  readonly onExpectedFailure?: (cause: Cause.Cause<E>) => Effect.Effect<void>;
  readonly retryExpectedFailureAfter?: Duration.Input;
}

/**
 * Follows a subscription across reconnects: each new session restarts it, and a dropped socket
 * ends the old one quietly because the supervisor is already replacing it. Subscriptions that
 * start with a snapshot therefore resynchronize after every reconnect.
 */
export const followSession = <A, E, R>(
  f: (client: WsRpcProtocolClient) => Stream.Stream<A, E, R>,
  options?: FollowSessionOptions<E>,
): Stream.Stream<A, E, R | ConnectionSupervisor.ConnectionSupervisor> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const supervisor = yield* ConnectionSupervisor.ConnectionSupervisor;

      return SubscriptionRef.changes(supervisor.session).pipe(
        Stream.switchMap(
          Option.match({
            onNone: () => Stream.empty,
            onSome: (session) => {
              let expectedFailureRetries = 0;

              const subscribeToSession = (): Stream.Stream<A, E, R> =>
                Stream.suspend(() => f(session.client)).pipe(
                  Stream.onFirst(() =>
                    Effect.sync(() => {
                      expectedFailureRetries = 0;
                    }),
                  ),
                  Stream.tapCause((cause) =>
                    options?.onDefect !== undefined &&
                    cause.reasons.some(
                      (reason) =>
                        Cause.isDieReason(reason) ||
                        (Cause.isFailReason(reason) &&
                          isRpcClientError(reason.error) &&
                          isRpcClientDefect(reason.error.reason)),
                    )
                      ? options.onDefect(cause)
                      : Effect.void,
                  ),
                  Stream.catchCause((cause) => {
                    const hasOnlyExpectedFailures =
                      cause.reasons.length > 0 && cause.reasons.every(Cause.isFailReason);

                    const isTransportFailure =
                      hasOnlyExpectedFailures &&
                      cause.reasons.every(
                        (reason) => Cause.isFailReason(reason) && isRpcClientError(reason.error),
                      );

                    if (isTransportFailure) {
                      return Stream.fromEffect(
                        Effect.logWarning(
                          "Durable RPC subscription lost its transport; waiting for the next session.",
                          { cause: Cause.pretty(cause) },
                        ),
                      ).pipe(Stream.drain);
                    }

                    if (hasOnlyExpectedFailures && options?.onExpectedFailure !== undefined) {
                      const handled = Stream.fromEffect(options.onExpectedFailure(cause)).pipe(
                        Stream.drain,
                      );

                      if (options.retryExpectedFailureAfter === undefined) return handled;

                      const retryDelay = Duration.millis(
                        Math.min(
                          Duration.toMillis(options.retryExpectedFailureAfter) *
                            2 ** expectedFailureRetries,
                          MAX_EXPECTED_FAILURE_RETRY_DELAY_MS,
                        ),
                      );

                      expectedFailureRetries += 1;

                      return handled.pipe(
                        Stream.concat(
                          Stream.fromEffect(Effect.sleep(retryDelay)).pipe(Stream.drain),
                        ),
                        Stream.concat(subscribeToSession()),
                      );
                    }

                    return Stream.failCause(cause);
                  }),
                );

              return subscribeToSession();
            },
          }),
        ),
      );
    }),
  );
