import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import * as Socket from "effect/unstable/socket/Socket";

import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionAttemptError,
  type ConnectionState,
  type PreparedConnection,
} from "../../src/connection/model.ts";
import {
  Connectivity,
  ConnectionWakeups,
  type ConnectionWakeup,
  type NetworkStatus,
} from "../../src/connection/platform.ts";
import { start } from "../../src/connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../../src/rpc/protocol.ts";
import { RpcSessionFactory, type RpcSession } from "../../src/rpc/session.ts";

const CONNECTION: PreparedConnection = {
  label: "test",
  prepareSocketUrl: Effect.succeed("ws://127.0.0.1:0/ws"),
};

interface ScriptedFactoryOptions {
  /** Probe behaviour for every minted session (default: succeed). */
  readonly probe?: Effect.Effect<void, ConnectionAttemptError>;
  /** Fail the first N connect attempts with this error before succeeding. */
  readonly failFirst?: {
    readonly count: number;
    readonly error: ConnectionAttemptError;
  };
}

/**
 * A session factory the tests drive by hand: every `connect` yields a session
 * whose socket "drops" when the test fails its `closed` deferred. The client
 * surface is never touched by the supervisor, so a cast stands in for it.
 */
const makeScriptedFactory = (options?: ScriptedFactoryOptions) =>
  Effect.gen(function* () {
    const closedDeferreds = yield* Ref.make<
      ReadonlyArray<Deferred.Deferred<never, ConnectionTransientError>>
    >([]);
    const attempts = yield* Ref.make(0);

    const connect = () =>
      Effect.gen(function* () {
        const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1);
        const failFirst = options?.failFirst;
        if (failFirst !== undefined && attempt <= failFirst.count) {
          return yield* Effect.fail(failFirst.error);
        }
        const closed = yield* Deferred.make<never, ConnectionTransientError>();
        yield* Ref.update(closedDeferreds, (all) => [...all, closed]);
        return {
          client: {} as WsRpcProtocolClient,
          ready: Effect.void,
          probe: options?.probe ?? Effect.void,
          closed: Deferred.await(closed),
        } satisfies RpcSession;
      });

    const connectCount = Ref.get(attempts);
    const sessionCount = Ref.get(closedDeferreds).pipe(Effect.map((all) => all.length));

    const dropCurrent = (detail: string) =>
      Ref.get(closedDeferreds).pipe(
        Effect.flatMap((all) => {
          const current = all[all.length - 1];
          return current === undefined
            ? Effect.die("dropCurrent called before any connect")
            : Deferred.fail(current, new ConnectionTransientError({ detail }));
        }),
      );

    return { factory: { connect }, connectCount, sessionCount, dropCurrent };
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
        (state) => state.phase === "connecting" && state.lastError !== null,
      );

      assert.equal(reconnecting.lastError, "mint failed");
      assert.isTrue((yield* Ref.get(attempts)) >= 1);
      assert.isTrue(Option.isNone(yield* SubscriptionRef.get(supervisor.session)));
    }).pipe(Effect.scoped, Effect.provide(Socket.layerWebSocketConstructorGlobal)),
  );

  it.effect("publishes the session while connected and clears it on drop", () =>
    Effect.gen(function* () {
      const scripted = yield* makeScriptedFactory();
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
      const scripted = yield* makeScriptedFactory();
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
      const scripted = yield* makeScriptedFactory();
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

  it.effect("retryNow cuts a pending backoff short", () =>
    Effect.gen(function* () {
      const scripted = yield* makeScriptedFactory();
      const supervisor = yield* start(CONNECTION).pipe(
        Effect.provideService(RpcSessionFactory, scripted.factory),
      );

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* scripted.dropCurrent("drop");
      yield* awaitState(supervisor.state, (state) => state.phase === "reconnecting");

      // No clock advance: only the retry signal can end the backoff sleep.
      yield* supervisor.retryNow;
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      assert.equal(yield* scripted.connectCount, 2);
    }).pipe(Effect.scoped, Effect.provide(Socket.layerWebSocketConstructorGlobal)),
  );

  it.effect("parks on a blocked failure until retryNow", () =>
    Effect.gen(function* () {
      const scripted = yield* makeScriptedFactory({
        failFirst: {
          count: 1,
          error: new ConnectionBlockedError({
            reason: "authentication",
            detail: "credential rejected",
          }),
        },
      });
      const supervisor = yield* start(CONNECTION).pipe(
        Effect.provideService(RpcSessionFactory, scripted.factory),
      );

      const blocked = yield* awaitState(supervisor.state, (state) => state.phase === "blocked");
      assert.equal(blocked.lastError, "credential rejected");

      // Time alone must NOT re-attempt: blocked is not a backoff.
      yield* TestClock.adjust("60 seconds");
      assert.equal(yield* scripted.connectCount, 1);

      yield* supervisor.retryNow;
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      assert.equal(yield* scripted.connectCount, 2);
    }).pipe(Effect.scoped, Effect.provide(Socket.layerWebSocketConstructorGlobal)),
  );

  it.effect("parks while offline and reconnects when the network returns", () =>
    Effect.gen(function* () {
      const scripted = yield* makeScriptedFactory();
      const networkEvents = yield* Queue.unbounded<NetworkStatus>();
      const supervisor = yield* start(CONNECTION).pipe(
        Effect.provideService(RpcSessionFactory, scripted.factory),
        Effect.provideService(Connectivity, {
          status: Effect.succeed("online"),
          changes: Stream.fromQueue(networkEvents),
        }),
      );

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      // Going offline recycles the live session into the offline park.
      yield* Queue.offer(networkEvents, "offline");
      yield* awaitState(supervisor.state, (state) => state.phase === "offline");
      assert.isTrue(Option.isNone(yield* SubscriptionRef.get(supervisor.session)));

      // Time alone must not burn attempts while offline.
      const attemptsWhileOffline = yield* scripted.connectCount;
      yield* TestClock.adjust("60 seconds");
      assert.equal(yield* scripted.connectCount, attemptsWhileOffline);

      // The online transition reconnects immediately — no backoff wait.
      yield* Queue.offer(networkEvents, "online");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      assert.isTrue(Option.isSome(yield* SubscriptionRef.get(supervisor.session)));
    }).pipe(Effect.scoped, Effect.provide(Socket.layerWebSocketConstructorGlobal)),
  );

  it.effect("rebuilds the session when an app-active probe fails", () =>
    Effect.gen(function* () {
      const scripted = yield* makeScriptedFactory({
        probe: Effect.fail(new ConnectionTransientError({ detail: "probe failed" })),
      });
      const wakeupEvents = yield* Queue.unbounded<ConnectionWakeup>();
      const supervisor = yield* start(CONNECTION).pipe(
        Effect.provideService(RpcSessionFactory, scripted.factory),
        Effect.provideService(ConnectionWakeups, {
          changes: Stream.fromQueue(wakeupEvents),
        }),
      );

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      assert.equal(yield* scripted.connectCount, 1);

      // The app comes back to the foreground over a zombie socket: the probe
      // fails, so the supervisor must declare the session dead and rebuild.
      yield* Queue.offer(wakeupEvents, "application-active");
      const failed = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "reconnecting",
      );
      assert.equal(failed.lastError, "probe failed");

      yield* TestClock.adjust("1 second");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      assert.equal(yield* scripted.connectCount, 2);
    }).pipe(Effect.scoped, Effect.provide(Socket.layerWebSocketConstructorGlobal)),
  );
});
