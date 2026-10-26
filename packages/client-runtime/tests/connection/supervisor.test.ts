import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import * as Connectivity from "../../src/connection/connectivity.ts";
import {
  type ConnectionAttemptError,
  ConnectionBlockedError,
  ConnectionTransientError,
  type SupervisorConnectionPhase,
} from "../../src/connection/model.ts";
import * as ConnectionSupervisor from "../../src/connection/supervisor.ts";
import * as ConnectionTarget from "../../src/connection/target.ts";
import * as ConnectionWakeups from "../../src/connection/wakeups.ts";
import * as RpcSession from "../../src/rpc/session.ts";
import type { WsRpcProtocolClient } from "../../src/rpc/protocol.ts";

type ProbeBehavior = "answer" | "hang";

// The WebSocket and the HTTP ticket request are the external seams; everything else is real.
const makeHarness = Effect.fn("test.makeHarness")(function* (options?: {
  readonly prepareFailures?: ReadonlyArray<ConnectionAttemptError>;
}) {
  const prepareFailures = yield* Ref.make(options?.prepareFailures ?? []);
  const sessionsOpened = yield* Ref.make(0);
  const probe = yield* Ref.make<ProbeBehavior>("answer");
  const probesAnswered = yield* Queue.unbounded<void>();
  const wakeups = yield* Queue.unbounded<ConnectionWakeups.ConnectionWakeup>();

  const layerTarget = Layer.succeed(
    ConnectionTarget.ConnectionTarget,
    ConnectionTarget.ConnectionTarget.of({
      label: "Test server",
      prepare: Ref.modify(prepareFailures, ([next, ...rest]) => [next, rest] as const).pipe(
        Effect.flatMap((failure) =>
          failure === undefined
            ? Effect.succeed({ socketUrl: "ws://test/ws" })
            : Effect.fail(failure),
        ),
      ),
    }),
  );
  const layerSessions = Layer.succeed(
    RpcSession.RpcSessionFactory,
    RpcSession.RpcSessionFactory.of({
      connect: () =>
        Effect.gen(function* () {
          yield* Ref.update(sessionsOpened, (count) => count + 1);
          const closed = yield* Deferred.make<never, ConnectionAttemptError>();
          return {
            // The supervisor never calls the client; the session's lifecycle is what it manages.
            client: {} as WsRpcProtocolClient,
            ready: Effect.void,
            probe: Ref.get(probe).pipe(
              Effect.flatMap((behavior) =>
                behavior === "answer" ? Queue.offer(probesAnswered, undefined) : Effect.never,
              ),
              Effect.asVoid,
            ),
            closed: Deferred.await(closed),
          } satisfies RpcSession.RpcSession;
        }),
    }),
  );
  const context = yield* Layer.build(
    ConnectionSupervisor.layer({ initiallyDesired: true }).pipe(
      Layer.provide(layerTarget),
      Layer.provide(layerSessions),
      Layer.provide(
        Connectivity.layer({ status: Effect.succeed("online"), changes: Stream.never }),
      ),
      Layer.provide(ConnectionWakeups.layer({ changes: Stream.fromQueue(wakeups) })),
    ),
  );
  const supervisor = Context.get(context, ConnectionSupervisor.ConnectionSupervisor);
  const awaitPhase = (phase: SupervisorConnectionPhase) =>
    SubscriptionRef.changes(supervisor.state).pipe(
      Stream.filter((state) => state.phase === phase),
      Stream.runHead,
      Effect.flatMap(Effect.fromOption),
    );
  return { supervisor, sessionsOpened, probe, probesAnswered, wakeups, awaitPhase };
});

describe("ConnectionSupervisor", () => {
  it.effect("connects when desired and publishes the session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.awaitPhase("connected");
      assert.isTrue(Option.isSome(yield* SubscriptionRef.get(harness.supervisor.session)));
    }),
  );

  it.effect("retries a transient failure after a backoff", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepareFailures: [new ConnectionTransientError({ reason: "network", detail: "down" })],
      });
      const backoff = yield* harness.awaitPhase("backoff");
      assert.strictEqual(backoff.lastFailure?.reason, "network");
      // The first retry waits between one and two seconds.
      yield* TestClock.adjust("2 seconds");
      yield* harness.awaitPhase("connected");
    }),
  );

  it.effect("waits on a blocked failure until asked to retry", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepareFailures: [new ConnectionBlockedError({ reason: "authentication", detail: "401" })],
      });
      yield* harness.awaitPhase("blocked");
      yield* TestClock.adjust("10 minutes");
      assert.strictEqual((yield* SubscriptionRef.get(harness.supervisor.state)).phase, "blocked");
      yield* harness.supervisor.retryNow;
      yield* harness.awaitPhase("connected");
    }),
  );

  it.effect("keeps a healthy session when the app wakes", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.awaitPhase("connected");
      yield* Queue.offer(harness.wakeups, "application-active");
      yield* Queue.take(harness.probesAnswered);
      yield* TestClock.adjust("30 seconds");
      assert.strictEqual(yield* Ref.get(harness.sessionsOpened), 1);
      assert.strictEqual((yield* SubscriptionRef.get(harness.supervisor.state)).phase, "connected");
    }),
  );

  it.effect("replaces a session that misses a health check without backing off", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.awaitPhase("connected");
      yield* Ref.set(harness.probe, "hang");
      yield* Queue.offer(harness.wakeups, "network-changed");
      // A network change allows the quick three-second health check.
      yield* TestClock.adjust("3 seconds");
      yield* SubscriptionRef.changes(harness.supervisor.state).pipe(
        Stream.filter((state) => state.phase === "connected" && state.generation === 2),
        Stream.runHead,
      );
      assert.strictEqual(yield* Ref.get(harness.sessionsOpened), 2);
    }),
  );

  it.effect("disconnects on request", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.awaitPhase("connected");
      yield* harness.supervisor.disconnect;
      yield* harness.awaitPhase("available");
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
