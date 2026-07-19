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
  ConnectionBlockedError,
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

  it.effect("converts unexpected session defects into retryable failures", () =>
    Effect.gen(function* () {
      const scripted = yield* makeScriptedFactory;
      const attempts = yield* Ref.make(0);
      const factory = {
        connect: () =>
          Ref.updateAndGet(attempts, (n) => n + 1).pipe(
            Effect.flatMap((attempt) =>
              attempt === 1
                ? Effect.die(new Error("Native transport defect."))
                : scripted.factory.connect(),
            ),
          ),
      };
      const supervisor = yield* start(CONNECTION).pipe(
        Effect.provideService(RpcSessionFactory, factory),
      );

      const failed = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "reconnecting" && state.attempt === 1,
      );
      assert.equal(failed.lastError, "test connection failed unexpectedly.");

      // The defect must not have killed the loop: the next attempt succeeds.
      yield* TestClock.adjust("1 second");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      assert.equal(yield* Ref.get(attempts), 2);
    }).pipe(Effect.scoped, Effect.provide(Socket.layerWebSocketConstructorGlobal)),
  );

  it.effect("retries when a session never becomes ready", () =>
    Effect.gen(function* () {
      const factory = {
        connect: () =>
          Effect.succeed({
            client: {} as WsRpcProtocolClient,
            connected: Effect.never,
            closed: Effect.never,
          } satisfies RpcSession),
      };
      const supervisor = yield* start(CONNECTION).pipe(
        Effect.provideService(RpcSessionFactory, factory),
      );

      yield* awaitState(supervisor.state, (state) => state.phase === "connecting");
      yield* TestClock.adjust("14 seconds");
      assert.equal((yield* SubscriptionRef.get(supervisor.state)).phase, "connecting");

      yield* TestClock.adjust("1 second");
      const retrying = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "reconnecting",
      );

      assert.equal(retrying.lastError, "test did not respond during connection setup.");
      assert.isTrue(Option.isNone(yield* SubscriptionRef.get(supervisor.session)));
    }).pipe(Effect.scoped, Effect.provide(Socket.layerWebSocketConstructorGlobal)),
  );

  it.effect("interrupts a connection attempt when setup times out", () =>
    Effect.gen(function* () {
      const factory = { connect: () => Effect.never };
      const supervisor = yield* start(CONNECTION).pipe(
        Effect.provideService(RpcSessionFactory, factory),
      );

      yield* awaitState(supervisor.state, (state) => state.phase === "connecting");
      yield* TestClock.adjust("15 seconds");
      const retrying = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "reconnecting" && state.attempt === 1,
      );

      assert.equal(retrying.lastError, "test did not respond during connection setup.");
    }).pipe(Effect.scoped, Effect.provide(Socket.layerWebSocketConstructorGlobal)),
  );

  it.effect("keeps blocked failures idle until an external signal requests another attempt", () =>
    Effect.gen(function* () {
      const scripted = yield* makeScriptedFactory;
      const attempts = yield* Ref.make(0);
      const factory = {
        connect: () =>
          Ref.updateAndGet(attempts, (n) => n + 1).pipe(
            Effect.flatMap((attempt) =>
              attempt === 1
                ? Effect.fail(
                    new ConnectionBlockedError({
                      reason: "authentication",
                      detail: "Authentication required.",
                    }),
                  )
                : scripted.factory.connect(),
            ),
          ),
      };
      const supervisor = yield* start(CONNECTION).pipe(
        Effect.provideService(RpcSessionFactory, factory),
      );

      const blocked = yield* awaitState(supervisor.state, (state) => state.phase === "blocked");
      assert.equal(blocked.lastError, "Authentication required.");
      assert.isTrue(Option.isNone(yield* SubscriptionRef.get(supervisor.session)));

      // Parked: no amount of elapsed time triggers another attempt.
      yield* TestClock.adjust("1 hour");
      assert.equal(yield* Ref.get(attempts), 1);
      assert.equal((yield* SubscriptionRef.get(supervisor.state)).phase, "blocked");

      // The external signal wakes the loop for an immediate fresh attempt.
      yield* supervisor.retryNow;
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      assert.equal(yield* Ref.get(attempts), 2);
    }).pipe(Effect.scoped, Effect.provide(Socket.layerWebSocketConstructorGlobal)),
  );

  it.effect("blocks when the credential mint is rejected outright", () =>
    Effect.gen(function* () {
      const mints = yield* Ref.make(0);
      const connection: PreparedConnection = {
        label: "test",
        prepareSocketUrl: Ref.update(mints, (n) => n + 1).pipe(
          Effect.andThen(
            Effect.fail(
              new ConnectionBlockedError({
                reason: "permission",
                detail: "The bootstrap credential was rejected.",
              }),
            ),
          ),
        ),
      };

      const supervisor = yield* start(connection);

      const blocked = yield* awaitState(supervisor.state, (state) => state.phase === "blocked");
      assert.equal(blocked.lastError, "The bootstrap credential was rejected.");

      yield* TestClock.adjust("1 hour");
      assert.equal(yield* Ref.get(mints), 1);

      // The retry mints again immediately (no backoff) and parks once more.
      yield* supervisor.retryNow;
      for (let i = 0; i < 100; i += 1) {
        const settled =
          (yield* Ref.get(mints)) === 2 &&
          (yield* SubscriptionRef.get(supervisor.state)).phase === "blocked";
        if (settled) break;
        yield* Effect.yieldNow;
      }
      assert.equal(yield* Ref.get(mints), 2);
      assert.equal((yield* SubscriptionRef.get(supervisor.state)).phase, "blocked");
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
