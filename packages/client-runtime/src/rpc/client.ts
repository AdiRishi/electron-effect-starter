import * as Cause from "effect/Cause";
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

/** Runs one request on the live session, failing at once when there is none. */
export const withClient = Effect.fn("RpcClient.withClient")(function* <A, E, R>(
  f: (client: WsRpcProtocolClient) => Effect.Effect<A, E, R>,
) {
  const supervisor = yield* ConnectionSupervisor.ConnectionSupervisor;
  const session = yield* SubscriptionRef.get(supervisor.session);
  if (Option.isNone(session)) return yield* new RpcUnavailableError();
  return yield* f(session.value.client);
});

/**
 * Follows a subscription across reconnects: each new session restarts it, and a dropped socket
 * ends the old one quietly because the supervisor is already replacing it. Subscriptions that
 * start with a snapshot therefore resynchronize after every reconnect.
 */
export const followSession = <A, E, R>(
  f: (client: WsRpcProtocolClient) => Stream.Stream<A, E, R>,
): Stream.Stream<A, E, R | ConnectionSupervisor.ConnectionSupervisor> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const supervisor = yield* ConnectionSupervisor.ConnectionSupervisor;
      return SubscriptionRef.changes(supervisor.session).pipe(
        Stream.switchMap(
          Option.match({
            onNone: () => Stream.empty,
            onSome: (session) =>
              f(session.client).pipe(
                Stream.catchCause((cause) =>
                  cause.reasons.some(
                    (reason) => Cause.isFailReason(reason) && isRpcClientError(reason.error),
                  )
                    ? Stream.empty
                    : Stream.failCause(cause),
                ),
              ),
          }),
        ),
      );
    }),
  );
