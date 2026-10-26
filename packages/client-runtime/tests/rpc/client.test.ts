import { NotesStorageError, WS_METHODS } from "@app/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcClientError from "effect/rpc/RpcClientError";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionState,
} from "../../src/connection/model.ts";
import * as ConnectionSupervisor from "../../src/connection/supervisor.ts";
import { type FollowSessionOptions, followSession } from "../../src/rpc/client.ts";
import { makeWsRpcProtocolClient, type WsRpcProtocolClient } from "../../src/rpc/protocol.ts";
import type * as RpcSession from "../../src/rpc/session.ts";

// The session's socket is the external seam: each fake client answers notes.subscribe with a
// stream the test controls, and the supervisor is a pair of refs the test drives.

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

type NotesSubscription = ReturnType<WsRpcProtocolClient[typeof WS_METHODS.subscribeNotes]>;

const makeClient = Effect.fn("TestRpcClient.makeClient")(function* (
  subscribeNotes: () => NotesSubscription,
) {
  const client = yield* makeWsRpcProtocolClient.pipe(Effect.provide(layerInertProtocol));

  return {
    ...client,
    // SAFETY: followSession calls the method without `asQueue`, so only its Stream overload runs.
    [WS_METHODS.subscribeNotes]:
      subscribeNotes as WsRpcProtocolClient[typeof WS_METHODS.subscribeNotes],
  } satisfies WsRpcProtocolClient;
});

function session(client: WsRpcProtocolClient): RpcSession.RpcSession {
  return { client, ready: Effect.void, probe: Effect.void, closed: Effect.never };
}

const makeHarness = Effect.fn("TestRpcClient.makeHarness")(function* () {
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE);

  const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.none(),
  );

  const retryCount = yield* Ref.make(0);

  const supervisor = ConnectionSupervisor.ConnectionSupervisor.of({
    state,
    session: activeSession,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Ref.update(retryCount, (count) => count + 1),
  });

  return { activeSession, retryCount, supervisor };
});

const followNotes = (options?: FollowSessionOptions<Stream.Error<NotesSubscription>>) =>
  followSession((client) => client[WS_METHODS.subscribeNotes]({}), options);

describe("followSession", () => {
  it.effect("switches durable subscriptions when the supervisor replaces the session", () =>
    Effect.gen(function* () {
      const subscriptions: string[] = [];
      const subscriptionChanges = yield* Queue.make<void>();

      const subscribeAs = (name: string) => () => {
        subscriptions.push(name);
        Queue.offerUnsafe(subscriptionChanges, undefined);

        return Stream.never;
      };

      const firstClient = yield* makeClient(subscribeAs("first"));
      const secondClient = yield* makeClient(subscribeAs("second"));
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      const awaitSubscriptions = Effect.fn("TestRpcClient.awaitSubscriptions")(function* (
        count: number,
      ) {
        for (;;) {
          if (subscriptions.length >= count) {
            return;
          }

          yield* Queue.take(subscriptionChanges);
        }
      });

      const subscriptionFiber = yield* followNotes().pipe(
        Stream.runDrain,
        Effect.provideService(ConnectionSupervisor.ConnectionSupervisor, supervisor),
        Effect.forkChild,
      );

      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      yield* awaitSubscriptions(1);
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      yield* awaitSubscriptions(2);
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("keeps durable subscriptions alive across a transport failure and new session", () =>
    Effect.gen(function* () {
      const subscriptions: string[] = [];
      const subscriptionChanges = yield* Queue.make<void>();

      const firstClient = yield* makeClient(() => {
        subscriptions.push("first");
        Queue.offerUnsafe(subscriptionChanges, undefined);

        return Stream.fail(
          new RpcClientError.RpcClientError({
            reason: new RpcClientError.RpcClientDefect({
              message: "socket closed",
              cause: new Error("socket closed"),
            }),
          }),
        );
      });

      const secondClient = yield* makeClient(() => {
        subscriptions.push("second");
        Queue.offerUnsafe(subscriptionChanges, undefined);

        return Stream.never;
      });

      const { activeSession, retryCount, supervisor } = yield* makeHarness();
      const warned = yield* Deferred.make<void>();

      const warnings = Logger.make<unknown, void>((options) => {
        if (options.logLevel === "Warn") Deferred.doneUnsafe(warned, Effect.void);
      });

      const subscriptionFiber = yield* followNotes().pipe(
        Stream.runDrain,
        Effect.provideService(ConnectionSupervisor.ConnectionSupervisor, supervisor),
        Effect.provide(Logger.layer([warnings])),
        Effect.forkChild,
      );

      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));

      // The failure is fully handled once its warning is logged, and the stream is still running.
      const firstOutcome = yield* Effect.raceFirst(
        Deferred.await(warned).pipe(Effect.as("warned")),
        Fiber.await(subscriptionFiber).pipe(Effect.as("ended")),
      );

      expect(firstOutcome).toBe("warned");
      expect(subscriptions).toEqual(["first"]);

      yield* SubscriptionRef.set(activeSession, Option.none());
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));

      while (subscriptions.length < 2) {
        yield* Queue.take(subscriptionChanges);
      }

      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("surfaces domain subscription failures without reconnecting", () =>
    Effect.gen(function* () {
      const domainError = new NotesStorageError({ operation: "list" });
      const client = yield* makeClient(() => Stream.fail(domainError));
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));

      const error = yield* followNotes().pipe(
        Stream.runDrain,
        Effect.provideService(ConnectionSupervisor.ConnectionSupervisor, supervisor),
        Effect.flip,
      );

      expect(error).toBe(domainError);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("keeps handled domain failures dormant until a replacement session arrives", () =>
    Effect.gen(function* () {
      const domainError = new NotesStorageError({ operation: "list" });
      const subscriptions: string[] = [];
      const subscriptionChanges = yield* Queue.make<void>();
      const observedFailures: unknown[] = [];
      const failureObserved = yield* Deferred.make<void>();

      const firstClient = yield* makeClient(() => {
        subscriptions.push("first");
        Queue.offerUnsafe(subscriptionChanges, undefined);

        return Stream.fail(domainError);
      });

      const secondClient = yield* makeClient(() => {
        subscriptions.push("second");
        Queue.offerUnsafe(subscriptionChanges, undefined);

        return Stream.never;
      });

      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));

      const subscriptionFiber = yield* followNotes({
        onExpectedFailure: (cause) =>
          Effect.sync(() => {
            observedFailures.push(Cause.squash(cause));
            Deferred.doneUnsafe(failureObserved, Effect.void);
          }),
      }).pipe(
        Stream.runDrain,
        Effect.provideService(ConnectionSupervisor.ConnectionSupervisor, supervisor),
        Effect.forkChild,
      );

      yield* Deferred.await(failureObserved);

      expect(subscriptions).toEqual(["first"]);
      expect(observedFailures).toEqual([domainError]);

      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));

      while (subscriptions.length < 2) {
        yield* Queue.take(subscriptionChanges);
      }

      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("does not classify stream subscription defects as expected failures", () =>
    Effect.gen(function* () {
      const defect = new Error("subscription invariant failed");
      let expectedFailureCount = 0;
      let streams = 0;
      const observedDefects: unknown[] = [];

      const client = yield* makeClient(() => {
        streams += 1;

        return Stream.die(defect);
      });

      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));

      const exit = yield* followNotes({
        onDefect: (cause) =>
          Effect.sync(() => {
            observedDefects.push(Cause.squash(cause));
          }),
        onExpectedFailure: () =>
          Effect.sync(() => {
            expectedFailureCount += 1;
          }),
        retryExpectedFailureAfter: "250 millis",
      }).pipe(
        Stream.runDrain,
        Effect.provideService(ConnectionSupervisor.ConnectionSupervisor, supervisor),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);

      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true);
        expect(Cause.squash(exit.cause)).toBe(defect);
      }

      expect(streams).toBe(1);
      expect(expectedFailureCount).toBe(0);
      expect(observedDefects).toEqual([defect]);
    }),
  );
});
