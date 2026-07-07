import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import * as Socket from "effect/unstable/socket/Socket";

import {
  ConnectionTransientError,
  type ConnectionState,
  type PreparedConnection,
} from "../../src/connection/model.ts";
import { start } from "../../src/connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../../src/rpc/protocol.ts";
import { RpcSessionFactory, type RpcSession } from "../../src/rpc/session.ts";

const CONNECTION: PreparedConnection = {
  label: "test",
  prepareSocketUrl: Effect.succeed("ws://127.0.0.1:0/ws"),
};

/**
 * A session factory the tests drive by hand: every `connect` yields a session
 * whose socket "drops" when the test fails its `closed` deferred. The client
 * surface is never touched by the supervisor, so a cast stands in for it.
 */
const makeScriptedFactory = Effect.gen(function* () {
  const closedDeferreds = yield* Ref.make<
    ReadonlyArray<Deferred.Deferred<never, ConnectionTransientError>>
  >([]);

  const connect = () =>
    Effect.gen(function* () {
      const closed = yield* Deferred.make<never, ConnectionTransientError>();
      yield* Ref.update(closedDeferreds, (all) => [...all, closed]);
      return {
        client: {} as WsRpcProtocolClient,
        connected: Effect.void,
        closed: Deferred.await(closed),
      } satisfies RpcSession;
    });

  const connectCount = Ref.get(closedDeferreds).pipe(Effect.map((all) => all.length));

  const dropCurrent = (detail: string) =>
    Ref.get(closedDeferreds).pipe(
      Effect.flatMap((all) => {
        const current = all[all.length - 1];
        return current === undefined
          ? Effect.die("dropCurrent called before any connect")
          : Deferred.fail(current, new ConnectionTransientError({ detail }));
      }),
    );

  return { factory: { connect }, connectCount, dropCurrent };
});

/** Await the first state (current or future) matching `predicate`. */
const awaitState = (
  states: SubscriptionRef.SubscriptionRef<ConnectionState>,
  predicate: (state: ConnectionState) => boolean,
) =>
  SubscriptionRef.changes(states).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.flatMap(
      Option.match({ onNone: () => Effect.die("state stream ended"), onSome: Effect.succeed }),
    ),
  );

describe("ConnectionSupervisor", () => {
  it.effect("keeps retrying when the credential mint fails, without freezing", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const connection: PreparedConnection = {
        label: "test",
        prepareSocketUrl: Ref.update(attempts, (n) => n + 1).pipe(
          Effect.andThen(Effect.fail(new ConnectionTransientError({ detail: "mint failed" }))),
        ),
      };

      const supervisor = yield* start(connection);

      const reconnecting = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "reconnecting",
      );

      assert.equal(reconnecting.lastError, "mint failed");
      assert.isTrue((yield* Ref.get(attempts)) >= 1);
      assert.isTrue(Option.isNone(yield* SubscriptionRef.get(supervisor.session)));
    }).pipe(Effect.scoped, Effect.provide(Socket.layerWebSocketConstructorGlobal)),
  );

  it.effect("publishes the session while connected and clears it on drop", () =>
    Effect.gen(function* () {
      const scripted = yield* makeScriptedFactory;
      const supervisor = yield* start(CONNECTION).pipe(
        Effect.provideService(RpcSessionFactory, scripted.factory),
      );

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      assert.isTrue(Option.isSome(yield* SubscriptionRef.get(supervisor.session)));

      yield* scripted.dropCurrent("socket dropped");
      const reconnecting = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "reconnecting",
      );

      assert.equal(reconnecting.lastError, "socket dropped");
      assert.isTrue(Option.isNone(yield* SubscriptionRef.get(supervisor.session)));

      // After the 1s backoff a fresh session is connected and republished.
      yield* TestClock.adjust("1 second");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      assert.isTrue(Option.isSome(yield* SubscriptionRef.get(supervisor.session)));
      assert.equal(yield* scripted.connectCount, 2);
    }).pipe(Effect.scoped, Effect.provide(Socket.layerWebSocketConstructorGlobal)),
  );

  it.effect("escalates backoff while the connection keeps flapping", () =>
    Effect.gen(function* () {
      const scripted = yield* makeScriptedFactory;
      const supervisor = yield* start(CONNECTION).pipe(
        Effect.provideService(RpcSessionFactory, scripted.factory),
      );

      // Three instant drops: the counter must climb 1 → 2 → 3 even though
      // every attempt technically "connected" before dying.
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* scripted.dropCurrent("flap 1");
      const first = yield* awaitState(supervisor.state, (state) => state.phase === "reconnecting");
      assert.equal(first.attempt, 1);

      yield* TestClock.adjust("1 second");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* scripted.dropCurrent("flap 2");
      const second = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "reconnecting" && state.attempt > 1,
      );
      assert.equal(second.attempt, 2);

      yield* TestClock.adjust("2 seconds");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* scripted.dropCurrent("flap 3");
      const third = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "reconnecting" && state.attempt > 2,
      );
      assert.equal(third.attempt, 3);
    }).pipe(Effect.scoped, Effect.provide(Socket.layerWebSocketConstructorGlobal)),
  );

  it.effect("resets backoff only after a stable (30s+) session", () =>
    Effect.gen(function* () {
      const scripted = yield* makeScriptedFactory;
      const supervisor = yield* start(CONNECTION).pipe(
        Effect.provideService(RpcSessionFactory, scripted.factory),
      );

      // Build up a failure streak of 2.
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* scripted.dropCurrent("flap 1");
      yield* TestClock.adjust("1 second");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* scripted.dropCurrent("flap 2");
      yield* TestClock.adjust("2 seconds");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      // This session survives past the stability window before dropping…
      yield* TestClock.adjust("30 seconds");
      yield* scripted.dropCurrent("late drop");

      // …so the streak resets: the next reconnect is attempt 1 again.
      const afterStable = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "reconnecting",
      );
      assert.equal(afterStable.attempt, 1);
    }).pipe(Effect.scoped, Effect.provide(Socket.layerWebSocketConstructorGlobal)),
  );
});
