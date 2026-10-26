import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as RpcSession from "../rpc/session.ts";
import * as Connectivity from "./connectivity.ts";
import {
  type ConnectionAttemptError,
  ConnectionTransientError,
  type NetworkStatus,
  type SupervisorConnectionState,
} from "./model.ts";
import * as ConnectionTarget from "./target.ts";
import * as ConnectionWakeups from "./wakeups.ts";

const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 300_000;

// A cold server with a large database can take a while to answer, and that is
// not a reason to drop a working connection.
const ESTABLISHMENT_TIMEOUT = "15 seconds";
const PROBE_TIMEOUT = Duration.seconds(15);
const QUICK_PROBE_TIMEOUT = Duration.seconds(3);

// A connection that stayed up this long resets the retry ladder when it drops.
const BACKOFF_RESET_AFTER_MS = 30_000;

interface SupervisorIntent {
  readonly desired: boolean;
  readonly network: NetworkStatus;
}

type SupervisorSignal = Data.TaggedEnum<{
  ConnectRequested: {};
  DisconnectRequested: {};
  RetryRequested: {};
  NetworkChanged: { readonly network: NetworkStatus };
  Wakeup: { readonly reason: ConnectionWakeups.ConnectionWakeup };
}>;

const SupervisorSignal = Data.taggedEnum<SupervisorSignal>();

type AttemptOutcome = Data.TaggedEnum<{
  Interrupted: { readonly established: boolean; readonly stable: boolean };
  Failure: {
    readonly established: boolean;
    readonly stable: boolean;
    readonly error: ConnectionAttemptError;
  };
}>;

const AttemptOutcome = Data.taggedEnum<AttemptOutcome>();

/** How the race to set up a session ended. */
type Establishment = Data.TaggedEnum<{
  Completed: { readonly exit: Exit.Exit<RpcSession.RpcSession, ConnectionAttemptError> };
  Abandoned: {};
  TimedOut: {};
}>;

const Establishment = Data.taggedEnum<Establishment>();

/** What ended one wait on a health probe. */
type ProbeEvent = Data.TaggedEnum<{
  ProbeCompleted: { readonly exit: Exit.Exit<void, ConnectionAttemptError> };
  Signal: { readonly signal: SupervisorSignal };
  TimedOut: {};
}>;

const ProbeEvent = Data.taggedEnum<ProbeEvent>();

// Only an explicit retry or going offline abandons an attempt in flight; other signals wait.
const abandonsEstablishment = SupervisorSignal.$match({
  ConnectRequested: () => false,
  DisconnectRequested: () => true,
  RetryRequested: () => true,
  NetworkChanged: ({ network }) => network === "offline",
  Wakeup: () => false,
});

// A signal that arrives while connected probes the live session within this timeout, if any.
const probeTimeoutFor = SupervisorSignal.$match({
  ConnectRequested: () => undefined,
  DisconnectRequested: () => undefined,
  RetryRequested: () => QUICK_PROBE_TIMEOUT,
  NetworkChanged: ({ network }) => (network === "offline" ? QUICK_PROBE_TIMEOUT : undefined),
  Wakeup: ({ reason }) => (reason === "application-active" ? PROBE_TIMEOUT : QUICK_PROBE_TIMEOUT),
});

const isWakeup = SupervisorSignal.$is("Wakeup");

/** Full jitter on an exponential ceiling, so many clients do not reconnect in lockstep. */
export function retryDelayMs(failureCount: number, random: number): number {
  const ceiling = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (failureCount + 1));

  return Math.round(ceiling / 2 + (ceiling / 2) * random);
}

function exitUnlessInterrupted<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Exit.Exit<A, E>, never, R> {
  return Effect.matchCauseEffect(effect, {
    onFailure: (cause) =>
      Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(Exit.failCause(cause)),
    onSuccess: (value) => Effect.succeed(Exit.succeed(value)),
  });
}

function stateFor(
  phase: SupervisorConnectionState["phase"],
  intent: SupervisorIntent,
  fields: Partial<Omit<SupervisorConnectionState, "phase" | "desired" | "network">> = {},
): SupervisorConnectionState {
  return {
    desired: intent.desired,
    network: intent.network,
    phase,
    attempt: fields.attempt ?? 0,
    generation: fields.generation ?? 0,
    lastFailure: fields.lastFailure ?? null,
    retryAt: fields.retryAt ?? null,
  };
}

function failureFromExit<A>(
  label: string,
  exit: Exit.Exit<A, ConnectionAttemptError>,
  established: boolean,
  stable: boolean,
): AttemptOutcome {
  if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) {
    return AttemptOutcome.Interrupted({ established, stable });
  }

  const typedFailure = exit.cause.reasons.find(Cause.isFailReason);

  return AttemptOutcome.Failure({
    established,
    stable,
    error:
      typedFailure?.error ??
      new ConnectionTransientError({
        reason: "transport",
        detail: `${label} connection failed unexpectedly.`,
      }),
  });
}

/**
 * Owns the one connection to the server: it is the only component that reconnects. It follows
 * the caller's intent, waits out offline periods, retries transient failures with jittered
 * backoff, parks on blocked failures until something changes, and probes a live socket when the
 * app wakes instead of tearing it down.
 */
export class ConnectionSupervisor extends Context.Service<
  ConnectionSupervisor,
  {
    readonly state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>;
    readonly session: SubscriptionRef.SubscriptionRef<Option.Option<RpcSession.RpcSession>>;
    readonly connect: Effect.Effect<void>;
    readonly disconnect: Effect.Effect<void>;
    readonly retryNow: Effect.Effect<void>;
  }
>()("@app/client-runtime/connection/supervisor/ConnectionSupervisor") {}

const make = Effect.fn("ConnectionSupervisor.make")(function* (options?: {
  readonly initiallyDesired?: boolean;
}) {
  const connectivity = yield* Connectivity.Connectivity;
  const wakeups = yield* ConnectionWakeups.ConnectionWakeups;
  const target = yield* ConnectionTarget.ConnectionTarget;
  const sessions = yield* RpcSession.RpcSessionFactory;

  const initialIntent: SupervisorIntent = {
    desired: options?.initiallyDesired ?? false,
    network: yield* connectivity.status,
  };

  const intent = yield* Ref.make(initialIntent);
  const signals = yield* Queue.unbounded<SupervisorSignal>();
  const resetRetryState = yield* Ref.make(false);
  const probeUnanswered = yield* Ref.make(false);

  const state = yield* SubscriptionRef.make(
    !initialIntent.desired
      ? stateFor("available", initialIntent)
      : initialIntent.network === "offline"
        ? stateFor("offline", initialIntent)
        : stateFor("connecting", initialIntent, { attempt: 1 }),
  );

  const session = yield* SubscriptionRef.make(Option.none<RpcSession.RpcSession>());

  const clearSession = SubscriptionRef.set(session, Option.none());
  const setState = (next: SupervisorConnectionState) => SubscriptionRef.set(state, next);
  const signal = (next: SupervisorSignal) => Queue.offer(signals, next).pipe(Effect.asVoid);

  const establish = Effect.gen(function* () {
    const { socketUrl } = yield* target.prepare;
    const opened = yield* sessions.connect({ label: target.label, socketUrl });
    yield* opened.ready;

    return opened;
  }).pipe(Effect.withSpan("ConnectionSupervisor.establish"));

  const waitForEstablishmentAbandoned = Queue.take(signals).pipe(
    Effect.repeat({ until: abandonsEstablishment }),
  );

  // Returning to the app, an explicit retry, and the network reporting offline all probe the live
  // session instead of replacing it, so a healthy socket is not torn down. The offline report is
  // often wrong, for example for a loopback server.
  const monitorConnectedSession = Effect.fnUntraced(function* (live: RpcSession.RpcSession) {
    // A probe answers an explicit retry here, so the retry must not also reset
    // the backoff of a later, unrelated failure.
    const takeSignal = Queue.take(signals).pipe(
      Effect.tap((next) =>
        SupervisorSignal.$is("RetryRequested")(next)
          ? Ref.set(resetRetryState, false)
          : Effect.void,
      ),
    );

    for (;;) {
      const next = yield* takeSignal;

      if (SupervisorSignal.$is("DisconnectRequested")(next)) return;
      const probeTimeout = probeTimeoutFor(next);

      if (probeTimeout === undefined) continue;
      yield* Ref.set(probeUnanswered, true);
      const probe = yield* Effect.forkChild(live.probe);
      let deadline = (yield* Clock.monotonicTimeNanos) + Duration.toNanosUnsafe(probeTimeout);

      for (;;) {
        const remaining = deadline - (yield* Clock.monotonicTimeNanos);

        const event = yield* Effect.raceAllFirst([
          Fiber.await(probe).pipe(Effect.map((exit) => ProbeEvent.ProbeCompleted({ exit }))),
          takeSignal.pipe(Effect.map((signal) => ProbeEvent.Signal({ signal }))),
          Effect.sleep(Duration.nanos(remaining > 0n ? remaining : 0n)).pipe(
            Effect.as(ProbeEvent.TimedOut()),
          ),
        ]);

        if (ProbeEvent.$is("TimedOut")(event)) {
          yield* Fiber.interrupt(probe);

          return yield* new ConnectionTransientError({
            reason: "timeout",
            detail: `${target.label} did not respond to a connection health check.`,
          });
        }

        if (ProbeEvent.$is("ProbeCompleted")(event)) {
          if (Exit.isSuccess(event.exit)) yield* Ref.set(probeUnanswered, false);
          yield* event.exit;
          break;
        }

        if (SupervisorSignal.$is("DisconnectRequested")(event.signal)) {
          yield* Fiber.interrupt(probe);

          return;
        }

        const signalTimeout = probeTimeoutFor(event.signal);

        if (signalTimeout !== undefined) {
          const signalDeadline =
            (yield* Clock.monotonicTimeNanos) + Duration.toNanosUnsafe(signalTimeout);

          if (signalDeadline < deadline) deadline = signalDeadline;
        }
      }
    }
  });

  const runAttempt = Effect.fnUntraced(function* (
    attempt: number,
    generation: number,
    lastFailure: ConnectionAttemptError | null,
  ) {
    yield* setState(
      stateFor("connecting", yield* Ref.get(intent), { attempt, generation, lastFailure }),
    );

    const establishment = yield* Effect.raceAllFirst([
      exitUnlessInterrupted(establish).pipe(
        Effect.map((exit) => Establishment.Completed({ exit })),
      ),
      waitForEstablishmentAbandoned.pipe(Effect.as(Establishment.Abandoned())),
      Effect.sleep(ESTABLISHMENT_TIMEOUT).pipe(Effect.as(Establishment.TimedOut())),
    ]);

    if (Establishment.$is("Abandoned")(establishment)) {
      return AttemptOutcome.Interrupted({ established: false, stable: false });
    }

    if (Establishment.$is("TimedOut")(establishment)) {
      return AttemptOutcome.Failure({
        established: false,
        stable: false,
        error: new ConnectionTransientError({
          reason: "timeout",
          detail: `${target.label} did not respond during connection setup.`,
        }),
      });
    }

    if (Exit.isFailure(establishment.exit)) {
      return failureFromExit(target.label, establishment.exit, false, false);
    }

    const live = establishment.exit.value;
    const currentIntent = yield* Ref.get(intent);

    if (!currentIntent.desired) {
      return AttemptOutcome.Interrupted({ established: false, stable: false });
    }

    const connectedAt = yield* Clock.currentTimeMillis;
    yield* SubscriptionRef.set(session, Option.some(live));
    yield* setState(stateFor("connected", currentIntent, { attempt, generation }));

    const connectedExit = yield* Effect.raceFirst(live.closed, monitorConnectedSession(live)).pipe(
      exitUnlessInterrupted,
    );

    const stable = (yield* Clock.currentTimeMillis) - connectedAt >= BACKOFF_RESET_AFTER_MS;

    return Exit.isSuccess(connectedExit)
      ? AttemptOutcome.Interrupted({ established: true, stable })
      : failureFromExit(target.label, connectedExit, true, stable);
  }, Effect.ensuring(clearSession));

  const waitForRetrySignal = Effect.fnUntraced(function* (delayMs: number) {
    // @effect-diagnostics-next-line raceFirstWithSleepToTimeout:off -- The sleep is the retry delay (false), not a timeout around the signal loop.
    return yield* Effect.raceFirst(
      Effect.sleep(delayMs).pipe(Effect.as(false)),
      Queue.take(signals).pipe(Effect.map(isWakeup)),
    );
  });

  const waitForSignal = Queue.take(signals).pipe(Effect.map(isWakeup));

  const run = Effect.fnUntraced(function* () {
    let failureCount = 0;
    let generation = 0;
    let latestFailure: ConnectionAttemptError | null = null;

    for (;;) {
      if (yield* Ref.getAndSet(resetRetryState, false)) {
        failureCount = 0;
        latestFailure = null;
      }

      const currentIntent = yield* Ref.get(intent);

      if (!currentIntent.desired) {
        failureCount = 0;
        latestFailure = null;
        yield* clearSession;
        yield* setState(stateFor("available", currentIntent, { generation }));
        yield* waitForSignal;
        continue;
      }

      if (currentIntent.network === "offline") {
        yield* clearSession;
        yield* setState(
          stateFor("offline", currentIntent, {
            attempt: failureCount + 1,
            generation,
            lastFailure: latestFailure,
          }),
        );

        if (yield* waitForSignal) failureCount = 0;
        continue;
      }

      const attempt = failureCount + 1;

      const outcome: AttemptOutcome = yield* Effect.scoped(
        runAttempt(attempt, generation + 1, latestFailure),
      );

      const failedProbe = yield* Ref.getAndSet(probeUnanswered, false);

      if (outcome.established) {
        generation += 1;
        // A session came up, so no earlier failure describes the connection.
        latestFailure = null;

        if (outcome.stable) failureCount = 0;
      }

      if (AttemptOutcome.$is("Interrupted")(outcome)) continue;

      if (!outcome.established) latestFailure = outcome.error;

      if (Predicate.isTagged(outcome.error, "ConnectionBlockedError")) {
        yield* setState(
          stateFor("blocked", yield* Ref.get(intent), {
            attempt,
            generation,
            lastFailure: outcome.error,
          }),
        );

        if (yield* waitForSignal) failureCount = 0;
        continue;
      }

      // A live socket that missed a health check is replaced at once, not after a backoff.
      if (failedProbe) {
        failureCount = 0;
        continue;
      }

      failureCount += 1;
      const delayMs = retryDelayMs(failureCount - 1, yield* Random.next);
      yield* setState(
        stateFor("backoff", yield* Ref.get(intent), {
          attempt,
          generation,
          lastFailure: latestFailure,
          retryAt: (yield* Clock.currentTimeMillis) + delayMs,
        }),
      );

      if (yield* waitForRetrySignal(delayMs)) failureCount = 0;
    }
  });

  yield* connectivity.changes.pipe(
    Stream.runForEach((network) =>
      Ref.modify(intent, (current) =>
        current.network === network ? [false, current] : ([true, { ...current, network }] as const),
      ).pipe(
        Effect.flatMap((changed) =>
          changed ? signal(SupervisorSignal.NetworkChanged({ network })) : Effect.void,
        ),
      ),
    ),
    Effect.forkScoped,
  );
  yield* wakeups.changes.pipe(
    Stream.runForEach((reason) => signal(SupervisorSignal.Wakeup({ reason }))),
    Effect.forkScoped,
  );
  yield* run().pipe(Effect.forkScoped);
  yield* Effect.addFinalizer(() => Queue.shutdown(signals).pipe(Effect.andThen(clearSession)));

  return ConnectionSupervisor.of({
    state,
    session,
    connect: Ref.update(intent, (current) => ({ ...current, desired: true })).pipe(
      Effect.andThen(signal(SupervisorSignal.ConnectRequested())),
      Effect.withSpan("ConnectionSupervisor.connect"),
    ),
    disconnect: Ref.update(intent, (current) => ({ ...current, desired: false })).pipe(
      Effect.andThen(signal(SupervisorSignal.DisconnectRequested())),
      Effect.withSpan("ConnectionSupervisor.disconnect"),
    ),
    retryNow: Ref.set(resetRetryState, true).pipe(
      Effect.andThen(signal(SupervisorSignal.RetryRequested())),
      Effect.withSpan("ConnectionSupervisor.retryNow"),
    ),
  });
});

export const layer = (options?: { readonly initiallyDesired?: boolean }) =>
  Layer.effect(ConnectionSupervisor, make(options));
