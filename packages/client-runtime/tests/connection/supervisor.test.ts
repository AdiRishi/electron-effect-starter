import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import * as Connectivity from "../../src/connection/connectivity.ts";
import {
  type ConnectionAttemptError,
  ConnectionBlockedError,
  ConnectionTransientError,
  type NetworkStatus,
  type SupervisorConnectionState,
} from "../../src/connection/model.ts";
import * as ConnectionSupervisor from "../../src/connection/supervisor.ts";
import * as ConnectionTarget from "../../src/connection/target.ts";
import * as ConnectionWakeups from "../../src/connection/wakeups.ts";
import { makeWsRpcProtocolClient } from "../../src/rpc/protocol.ts";
import * as RpcSession from "../../src/rpc/session.ts";

// The WebSocket and the HTTP ticket request are the external seams; everything else is real.

// The supervisor manages a session's lifecycle and never sends a request, so the client's
// transport never answers.
const layerInertProtocol = Layer.succeed(
  RpcClient.Protocol,
  RpcClient.Protocol.of({
    run: () => Effect.never,
    send: () => Effect.void,
    supportsAck: true,
    supportsTransferables: false,
    codecFor: RpcSerialization.json.codecFor,
  }),
);

const transient = (detail = "The server is unreachable.") =>
  new ConnectionTransientError({ reason: "network", detail });

const makeHarness = Effect.fn("test.makeHarness")(function* (options?: {
  readonly initiallyDesired?: boolean;
  readonly network?: NetworkStatus;
  /** Runs for each connection attempt, numbered from 1. */
  readonly prepare?: (attempt: number) => Effect.Effect<void, ConnectionAttemptError>;
  /** Runs for each health probe of the numbered session. */
  readonly probe?: (session: number) => Effect.Effect<void, ConnectionAttemptError>;
}) {
  const prepareCount = yield* Ref.make(0);
  const sessionCount = yield* Ref.make(0);
  const releaseCount = yield* Ref.make(0);

  const latestClosed = yield* Ref.make(
    Option.none<Deferred.Deferred<never, ConnectionAttemptError>>(),
  );

  const network = yield* SubscriptionRef.make(options?.network ?? "online");
  const wakeups = yield* Queue.unbounded<ConnectionWakeups.ConnectionWakeup>();

  const layerTarget = Layer.succeed(
    ConnectionTarget.ConnectionTarget,
    ConnectionTarget.ConnectionTarget.of({
      label: "Test server",
      prepare: Ref.updateAndGet(prepareCount, (count) => count + 1).pipe(
        Effect.flatMap((attempt) => options?.prepare?.(attempt) ?? Effect.void),
        Effect.as({ socketUrl: "ws://test/ws" }),
      ),
    }),
  );

  const layerSessions = Layer.succeed(
    RpcSession.RpcSessionFactory,
    RpcSession.RpcSessionFactory.of({
      connect: () =>
        Effect.gen(function* () {
          const session = yield* Ref.updateAndGet(sessionCount, (count) => count + 1);
          const closed = yield* Deferred.make<never, ConnectionAttemptError>();

          yield* Ref.set(latestClosed, Option.some(closed));
          yield* Effect.addFinalizer(() => Ref.update(releaseCount, (count) => count + 1));

          return {
            client: yield* makeWsRpcProtocolClient.pipe(Effect.provide(layerInertProtocol)),
            ready: Effect.void,
            probe: options?.probe?.(session) ?? Effect.void,
            closed: Deferred.await(closed),
          } satisfies RpcSession.RpcSession;
        }),
    }),
  );

  const context = yield* Layer.build(
    ConnectionSupervisor.layer({ initiallyDesired: options?.initiallyDesired ?? true }).pipe(
      Layer.provide(layerTarget),
      Layer.provide(layerSessions),
      Layer.provide(
        Connectivity.layer({
          status: SubscriptionRef.get(network),
          changes: SubscriptionRef.changes(network),
        }),
      ),
      Layer.provide(ConnectionWakeups.layer({ changes: Stream.fromQueue(wakeups) })),
    ),
  );

  const supervisor = Context.get(context, ConnectionSupervisor.ConnectionSupervisor);

  const awaitState = (predicate: (state: SupervisorConnectionState) => boolean) =>
    SubscriptionRef.changes(supervisor.state).pipe(
      Stream.filter(predicate),
      Stream.runHead,
      Effect.flatMap(Effect.fromOption),
    );

  const closeLatestSession = Ref.get(latestClosed).pipe(
    Effect.flatMap(Effect.fromOption),
    Effect.flatMap((closed) =>
      Deferred.fail(
        closed,
        new ConnectionTransientError({ reason: "transport", detail: "The socket closed." }),
      ),
    ),
  );

  return {
    supervisor,
    prepareCount,
    sessionCount,
    releaseCount,
    awaitState,
    closeLatestSession,
    setNetwork: (status: NetworkStatus) => SubscriptionRef.set(network, status),
    wake: (reason: ConnectionWakeups.ConnectionWakeup) => Queue.offer(wakeups, reason),
  };
});

describe("ConnectionSupervisor", () => {
  it.effect("does not attempt a connection until it is desired", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ initiallyDesired: false });

      yield* TestClock.adjust("1 minute");
      assert.strictEqual((yield* SubscriptionRef.get(harness.supervisor.state)).phase, "available");
      assert.strictEqual(yield* Ref.get(harness.prepareCount), 0);
    }),
  );

  it.effect("connects when desired and publishes the session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* harness.awaitState((state) => state.phase === "connected");
      assert.isTrue(Option.isSome(yield* SubscriptionRef.get(harness.supervisor.session)));
    }),
  );

  it.effect("does not let the initial connect signal cancel the first attempt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ initiallyDesired: false });

      yield* harness.supervisor.connect;
      yield* harness.awaitState((state) => state.phase === "connected");
      assert.strictEqual(yield* Ref.get(harness.sessionCount), 1);
      assert.strictEqual(yield* Ref.get(harness.releaseCount), 0);
    }),
  );

  it.effect("waits while offline and connects immediately when the network returns", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ network: "offline" });

      yield* harness.awaitState((state) => state.phase === "offline");
      assert.strictEqual(yield* Ref.get(harness.prepareCount), 0);

      yield* harness.setNetwork("online");
      const connected = yield* harness.awaitState((state) => state.phase === "connected");
      assert.deepStrictEqual(
        {
          network: connected.network,
          attempt: connected.attempt,
          generation: connected.generation,
          lastFailure: connected.lastFailure,
        },
        { network: "online", attempt: 1, generation: 1, lastFailure: null },
      );
      assert.strictEqual(yield* Ref.get(harness.prepareCount), 1);
    }),
  );

  it.effect("retries a transient failure after a backoff", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) => (attempt === 1 ? Effect.fail(transient()) : Effect.void),
      });

      const backoff = yield* harness.awaitState((state) => state.phase === "backoff");
      assert.strictEqual(backoff.lastFailure?.reason, "network");
      // The first retry waits between one and two seconds.
      yield* TestClock.adjust("2 seconds");
      yield* harness.awaitState((state) => state.phase === "connected");
    }),
  );

  it.effect("keeps the latest failure visible throughout the next connection attempt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(transient("The handshake timed out.")) : Effect.never,
      });

      yield* harness.awaitState((state) => state.phase === "backoff" && state.attempt === 1);
      yield* TestClock.adjust("2 seconds");

      const retrying = yield* harness.awaitState(
        (state) => state.phase === "connecting" && state.attempt === 2,
      );

      assert.instanceOf(retrying.lastFailure, ConnectionTransientError);
      assert.strictEqual(retrying.lastFailure?.detail, "The handshake timed out.");
    }),
  );

  it.effect("converts unexpected driver defects into retryable failures", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.die(new Error("Native transport defect.")) : Effect.void,
      });

      const failed = yield* harness.awaitState(
        (state) => state.phase === "backoff" && state.attempt === 1,
      );

      assert.instanceOf(failed.lastFailure, ConnectionTransientError);
      assert.strictEqual(failed.lastFailure?.reason, "transport");
      assert.strictEqual(failed.lastFailure?.detail, "Test server connection failed unexpectedly.");

      yield* TestClock.adjust("2 seconds");
      yield* harness.awaitState((state) => state.phase === "connected");
      assert.strictEqual(yield* Ref.get(harness.prepareCount), 2);
    }),
  );

  it.effect("explicit retry interrupts the current backoff", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) => (attempt === 1 ? Effect.fail(transient()) : Effect.void),
      });

      yield* harness.awaitState((state) => state.phase === "backoff");
      yield* harness.supervisor.retryNow;
      yield* harness.awaitState((state) => state.phase === "connected");
      assert.strictEqual(yield* Ref.get(harness.prepareCount), 2);
    }),
  );

  it.effect("waits on a blocked failure until asked to retry", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1
            ? Effect.fail(new ConnectionBlockedError({ reason: "authentication", detail: "401" }))
            : Effect.void,
      });

      yield* harness.awaitState((state) => state.phase === "blocked");
      yield* TestClock.adjust("10 minutes");
      assert.strictEqual((yield* SubscriptionRef.get(harness.supervisor.state)).phase, "blocked");
      yield* harness.supervisor.retryNow;
      yield* harness.awaitState((state) => state.phase === "connected");
    }),
  );

  it.effect("does not let wakeups reset an in-flight attempt", () =>
    Effect.gen(function* () {
      const attemptStarted = yield* Deferred.make<void>();

      const harness = yield* makeHarness({
        prepare: () =>
          Deferred.succeed(attemptStarted, undefined).pipe(Effect.andThen(Effect.never)),
      });

      yield* Deferred.await(attemptStarted);
      yield* Effect.all(
        [
          harness.wake("network-changed"),
          harness.wake("application-active"),
          harness.wake("network-changed"),
        ],
        { concurrency: "unbounded" },
      );
      yield* Effect.yieldNow;
      assert.strictEqual(yield* Ref.get(harness.prepareCount), 1);

      // Setup gives up after 15 seconds.
      yield* TestClock.adjust("15 seconds");

      const timedOut = yield* harness.awaitState(
        (state) => state.phase === "backoff" && state.attempt === 1,
      );

      assert.strictEqual(timedOut.lastFailure?.reason, "timeout");
      assert.strictEqual(
        timedOut.lastFailure?.detail,
        "Test server did not respond during connection setup.",
      );
      assert.strictEqual(yield* Ref.get(harness.prepareCount), 1);
      assert.strictEqual(yield* Ref.get(harness.sessionCount), 0);
    }),
  );

  it.effect("treats an involuntary session close as transient and reconnects", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* harness.awaitState((state) => state.phase === "connected");
      yield* harness.closeLatestSession;
      yield* harness.awaitState((state) => state.phase === "backoff" && state.attempt === 1);
      assert.isTrue(Option.isNone(yield* SubscriptionRef.get(harness.supervisor.session)));

      yield* TestClock.adjust("2 seconds");
      yield* harness.awaitState((state) => state.phase === "connected" && state.generation === 2);
      assert.strictEqual(yield* Ref.get(harness.sessionCount), 2);
      assert.isTrue(Option.isSome(yield* SubscriptionRef.get(harness.supervisor.session)));
    }),
  );

  it.effect("keeps a healthy session when the app wakes", () =>
    Effect.gen(function* () {
      const probesAnswered = yield* Queue.unbounded<void>();

      const harness = yield* makeHarness({
        probe: () => Queue.offer(probesAnswered, undefined).pipe(Effect.asVoid),
      });

      yield* harness.awaitState((state) => state.phase === "connected");
      yield* harness.wake("application-active");
      yield* Queue.take(probesAnswered);
      yield* TestClock.adjust("30 seconds");
      assert.strictEqual(yield* Ref.get(harness.sessionCount), 1);
      assert.strictEqual((yield* SubscriptionRef.get(harness.supervisor.state)).phase, "connected");
    }),
  );

  it.effect("replaces a session that misses a health check without backing off", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        probe: (session) => (session === 1 ? Effect.never : Effect.void),
      });

      yield* harness.awaitState((state) => state.phase === "connected");
      yield* harness.wake("network-changed");
      // A network change allows the quick three-second health check.
      yield* TestClock.adjust("3 seconds");
      yield* harness.awaitState((state) => state.phase === "connected" && state.generation === 2);
      assert.strictEqual(yield* Ref.get(harness.sessionCount), 2);
    }),
  );

  it.effect("reconnects immediately when the session closes during a probe", () =>
    Effect.gen(function* () {
      const probeStarted = yield* Deferred.make<void>();

      const harness = yield* makeHarness({
        probe: (session) =>
          session === 1
            ? Deferred.succeed(probeStarted, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
      });

      yield* harness.awaitState((state) => state.phase === "connected");
      yield* harness.wake("application-active");
      yield* Deferred.await(probeStarted);
      yield* harness.closeLatestSession;

      const reconnected = yield* harness.awaitState(
        (state) => state.phase === "connected" && state.generation === 2,
      );

      assert.strictEqual(reconnected.attempt, 1);
      assert.strictEqual(yield* Ref.get(harness.sessionCount), 2);
    }),
  );

  it.effect("reconnects immediately when the liveness probe fails", () =>
    Effect.gen(function* () {
      const allowReconnect = yield* Deferred.make<void>();

      const harness = yield* makeHarness({
        prepare: (attempt) => (attempt === 2 ? Deferred.await(allowReconnect) : Effect.void),
        probe: (session) =>
          session === 1 ? Effect.fail(transient("The live session is stale.")) : Effect.void,
      });

      yield* harness.awaitState((state) => state.phase === "connected");
      yield* harness.wake("application-active");
      const reconnecting = yield* harness.awaitState((state) => state.phase === "connecting");
      assert.strictEqual(reconnecting.attempt, 1);
      assert.isNull(reconnecting.lastFailure);
      assert.isTrue(Option.isNone(yield* SubscriptionRef.get(harness.supervisor.session)));

      yield* Deferred.succeed(allowReconnect, undefined);
      yield* harness.awaitState(
        (state) => state.phase === "connected" && state.generation === 2 && state.attempt === 1,
      );
      assert.strictEqual(yield* Ref.get(harness.sessionCount), 2);
      assert.strictEqual(yield* Ref.get(harness.releaseCount), 1);
    }),
  );

  it.effect("disconnects on request", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* harness.awaitState((state) => state.phase === "connected");
      yield* harness.supervisor.disconnect;
      yield* harness.awaitState((state) => state.phase === "available");
      assert.isTrue(Option.isNone(yield* SubscriptionRef.get(harness.supervisor.session)));
    }),
  );

  it.effect("honors an explicit disconnect while a probe is stalled", () =>
    Effect.gen(function* () {
      const probeStarted = yield* Deferred.make<void>();

      const harness = yield* makeHarness({
        probe: () => Deferred.succeed(probeStarted, undefined).pipe(Effect.andThen(Effect.never)),
      });

      yield* harness.awaitState((state) => state.phase === "connected");
      yield* harness.wake("application-active");
      yield* Deferred.await(probeStarted);
      yield* harness.supervisor.disconnect;
      yield* harness.awaitState((state) => state.phase === "available");
      assert.strictEqual(yield* Ref.get(harness.releaseCount), 1);
    }),
  );

  it.effect("does not lose an explicit disconnect among concurrent wakeups", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* harness.awaitState((state) => state.phase === "connected");
      yield* Effect.all(
        [
          harness.supervisor.disconnect,
          harness.wake("network-changed"),
          harness.wake("application-active"),
          harness.wake("network-changed"),
        ],
        { concurrency: "unbounded" },
      );
      yield* harness.awaitState((state) => state.phase === "available");
      assert.strictEqual(yield* Ref.get(harness.releaseCount), 1);
      assert.isTrue(Option.isNone(yield* SubscriptionRef.get(harness.supervisor.session)));
    }),
  );
});

describe("retryDelayMs", () => {
  it("stays between half and all of an exponential ceiling capped at five minutes", () => {
    assert.strictEqual(ConnectionSupervisor.retryDelayMs(0, 0), 1_000);
    assert.strictEqual(ConnectionSupervisor.retryDelayMs(0, 1), 2_000);
    assert.strictEqual(ConnectionSupervisor.retryDelayMs(3, 1), 16_000);
    assert.strictEqual(ConnectionSupervisor.retryDelayMs(20, 1), 300_000);
  });
});
