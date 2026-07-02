import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/unstable/rpc";

import { EnvironmentAuthorizationError, WS_METHODS, type TickEvent } from "@app/contracts";

import { INITIAL_CONNECTION_STATE, type ConnectionState } from "../connection/model.ts";
import { ConnectionSupervisor } from "../connection/supervisor.ts";
import { RpcUnavailableError, request, subscribe } from "./client.ts";
import type { WsRpcProtocolClient } from "./protocol.ts";
import type { RpcSession } from "./session.ts";

const AT = DateTime.makeUnsafe(0);

const tick = (n: number): TickEvent => ({ tick: n, at: AT });

/** A live-looking session around a hand-rolled client record. */
const session = (client: WsRpcProtocolClient): RpcSession => ({
  client,
  connected: Effect.void,
  closed: Effect.never,
});

const transportError = () =>
  new RpcClientError.RpcClientError({
    reason: new RpcClientError.RpcClientDefect({
      message: "socket closed",
      cause: new Error("socket closed"),
    }),
  });

/** A fake supervisor whose session ref the test drives by hand. */
const makeHarness = Effect.gen(function* () {
  const state = yield* SubscriptionRef.make<ConnectionState>(INITIAL_CONNECTION_STATE);
  const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession>>(Option.none());
  const supervisor = ConnectionSupervisor.of({ state, session: activeSession });
  return { activeSession, supervisor };
});

describe("rpc client", () => {
  it.effect("request fails fast with RpcUnavailableError while disconnected", () =>
    Effect.gen(function* () {
      const { supervisor } = yield* makeHarness;

      const exit = yield* request(WS_METHODS.echo, { message: "hello" }).pipe(
        Effect.provideService(ConnectionSupervisor, supervisor),
        Effect.exit,
      );

      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const unavailable = exit.cause.reasons.some(
          (reason) => reason._tag === "Fail" && reason.error instanceof RpcUnavailableError,
        );
        assert.isTrue(unavailable, "expected RpcUnavailableError");
      }
    }),
  );

  it.effect("request runs against the live session", () =>
    Effect.gen(function* () {
      const { activeSession, supervisor } = yield* makeHarness;
      const client = {
        [WS_METHODS.echo]: (input: { readonly message: string }) =>
          Effect.succeed({ message: input.message, receivedAt: AT }),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));

      const result = yield* request(WS_METHODS.echo, { message: "hello" }).pipe(
        Effect.provideService(ConnectionSupervisor, supervisor),
      );

      assert.equal(result.message, "hello");
    }),
  );

  it.effect("subscribe re-attaches to each fresh session across reconnects", () =>
    Effect.gen(function* () {
      const { activeSession, supervisor } = yield* makeHarness;
      const firstTicks = yield* Queue.unbounded<TickEvent>();
      const secondTicks = yield* Queue.unbounded<TickEvent>();
      const firstClient = {
        [WS_METHODS.subscribeTicks]: () => Stream.fromQueue(firstTicks),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTicks]: () => Stream.fromQueue(secondTicks),
      } as unknown as WsRpcProtocolClient;

      const values = yield* Ref.make<ReadonlyArray<number>>([]);
      const sawFirst = yield* Deferred.make<void>();
      const sawSecond = yield* Deferred.make<void>();

      const consumer = yield* Effect.forkChild(
        subscribe(WS_METHODS.subscribeTicks, {}).pipe(
          Stream.runForEach((event) =>
            Ref.updateAndGet(values, (current) => [...current, event.tick]).pipe(
              Effect.flatMap((current) =>
                current.length === 1
                  ? Deferred.succeed(sawFirst, undefined).pipe(Effect.asVoid)
                  : current.length === 2
                    ? Deferred.succeed(sawSecond, undefined).pipe(Effect.asVoid)
                    : Effect.void,
              ),
            ),
          ),
          Effect.provideService(ConnectionSupervisor, supervisor),
        ),
      );

      // First session delivers, then the connection drops and a new session
      // replaces it — the consumer must keep receiving without re-subscribing.
      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      yield* Queue.offer(firstTicks, tick(1));
      yield* Deferred.await(sawFirst);

      yield* SubscriptionRef.set(activeSession, Option.none());
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      yield* Queue.offer(secondTicks, tick(2));
      yield* Deferred.await(sawSecond);

      assert.deepEqual(yield* Ref.get(values), [1, 2]);
      yield* Fiber.interrupt(consumer);
    }),
  );

  it.effect("subscribe goes quiet on a transport failure and survives to re-attach", () =>
    Effect.gen(function* () {
      const { activeSession, supervisor } = yield* makeHarness;
      const failingClient = {
        [WS_METHODS.subscribeTicks]: () => Stream.fail(transportError()),
      } as unknown as WsRpcProtocolClient;
      const nextTicks = yield* Queue.unbounded<TickEvent>();
      const nextClient = {
        [WS_METHODS.subscribeTicks]: () => Stream.fromQueue(nextTicks),
      } as unknown as WsRpcProtocolClient;

      const values = yield* Ref.make<ReadonlyArray<number>>([]);
      const sawValue = yield* Deferred.make<void>();

      const consumer = yield* Effect.forkChild(
        subscribe(WS_METHODS.subscribeTicks, {}).pipe(
          Stream.runForEach((event) =>
            Ref.update(values, (current) => [...current, event.tick]).pipe(
              Effect.andThen(Deferred.succeed(sawValue, undefined)),
            ),
          ),
          Effect.provideService(ConnectionSupervisor, supervisor),
        ),
      );

      // The transport failure must not kill the consumer...
      yield* SubscriptionRef.set(activeSession, Option.some(session(failingClient)));
      // ...so a later session still delivers.
      yield* SubscriptionRef.set(activeSession, Option.none());
      yield* SubscriptionRef.set(activeSession, Option.some(session(nextClient)));
      yield* Queue.offer(nextTicks, tick(7));
      yield* Deferred.await(sawValue);

      assert.deepEqual(yield* Ref.get(values), [7]);
      yield* Fiber.interrupt(consumer);
    }),
  );

  it.effect("subscribe propagates domain failures to the consumer", () =>
    Effect.gen(function* () {
      const { activeSession, supervisor } = yield* makeHarness;
      const rejectingClient = {
        [WS_METHODS.subscribeTicks]: () =>
          Stream.fail(new EnvironmentAuthorizationError({ reason: "expired" })),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(activeSession, Option.some(session(rejectingClient)));

      const exit = yield* subscribe(WS_METHODS.subscribeTicks, {}).pipe(
        Stream.runCollect,
        Effect.provideService(ConnectionSupervisor, supervisor),
        Effect.exit,
      );

      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const authFailure = exit.cause.reasons.some(
          (reason) =>
            reason._tag === "Fail" && reason.error instanceof EnvironmentAuthorizationError,
        );
        assert.isTrue(authFailure, "expected the authorization error to surface");
      }
    }),
  );
});
