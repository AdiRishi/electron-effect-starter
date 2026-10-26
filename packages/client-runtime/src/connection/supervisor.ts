import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
const PROBE_TIMEOUT = "15 seconds";
const QUICK_PROBE_TIMEOUT = "3 seconds";
// A connection that stayed up this long resets the retry ladder when it drops.
const BACKOFF_RESET_AFTER_MS = 30_000;

interface SupervisorIntent {
  readonly desired: boolean;
  readonly network: NetworkStatus;
}

type SupervisorSignal =
  | { readonly _tag: "ConnectRequested" }
  | { readonly _tag: "DisconnectRequested" }
  | { readonly _tag: "RetryRequested" }
  | { readonly _tag: "NetworkChanged"; readonly network: NetworkStatus }
  | { readonly _tag: "Wakeup"; readonly reason: ConnectionWakeups.ConnectionWakeup };

type AttemptOutcome =
  | { readonly _tag: "Interrupted"; readonly established: boolean; readonly stable: boolean }
  | {
      readonly _tag: "Failure";
      readonly established: boolean;
      readonly stable: boolean;
      readonly error: ConnectionAttemptError;
    };

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
    return { _tag: "Interrupted", established, stable };
  }
  const typedFailure = exit.cause.reasons.find(Cause.isFailReason);
  return {
    _tag: "Failure",
    established,
    stable,
    error:
      typedFailure?.error ??
      new ConnectionTransientError({
        reason: "transport",
        detail: `${label} connection failed unexpectedly.`,
      }),
  };
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

  // Only an explicit retry or going offline abandons an attempt in flight; other signals wait.
  const waitForEstablishmentInterrupt = Effect.gen(function* () {
    for (;;) {
      const next = yield* Queue.take(signals);
      if (next._tag === "DisconnectRequested" || next._tag === "RetryRequested") return;
      if (next._tag === "NetworkChanged" && next.network === "offline") return;
    }
  });

  const probeTimeoutFor = (next: SupervisorSignal): Duration.Input | undefined => {
    switch (next._tag) {
      case "RetryRequested":
        return QUICK_PROBE_TIMEOUT;
      case "NetworkChanged":
        return next.network === "offline" ? QUICK_PROBE_TIMEOUT : undefined;
      case "Wakeup":
        return next.reason === "application-active" ? PROBE_TIMEOUT : QUICK_PROBE_TIMEOUT;
      case "ConnectRequested":
      case "DisconnectRequested":
        return undefined;
    }
  };

  // Returning to the app, an explicit retry, and the network reporting offline all probe the live
  // session instead of replacing it, so a healthy socket is not torn down. The offline report is
  // often wrong, for example for a loopback server.
  const monitorConnectedSession = Effect.fnUntraced(function* (live: RpcSession.RpcSession) {
    // A probe answers an explicit retry here, so the retry must not also reset
    // the backoff of a later, unrelated failure.
    const takeSignal = Queue.take(signals).pipe(
      Effect.tap((next) =>
        next._tag === "RetryRequested" ? Ref.set(resetRetryState, false) : Effect.void,
      ),
    );
    for (;;) {
      const next = yield* takeSignal;
      if (next._tag === "DisconnectRequested") return;
      const probeTimeout = probeTimeoutFor(next);
      if (probeTimeout === undefined) continue;
      yield* Ref.set(probeUnanswered, true);
      const probe = yield* Effect.forkChild(live.probe);
      let deadline = (yield* Clock.monotonicTimeNanos) + Duration.toNanosUnsafe(probeTimeout);
      for (;;) {
        const remaining = deadline - (yield* Clock.monotonicTimeNanos);
        const event = yield* Effect.raceAllFirst([
          Fiber.await(probe).pipe(
            Effect.map((exit) => ({ _tag: "ProbeCompleted" as const, exit })),
          ),
          takeSignal.pipe(Effect.map((signal) => ({ _tag: "Signal" as const, signal }))),
          Effect.sleep(Duration.nanos(remaining > 0n ? remaining : 0n)).pipe(
            Effect.as({ _tag: "TimedOut" as const }),
          ),
        ]);
        if (event._tag === "TimedOut") {
          yield* Fiber.interrupt(probe);
          return yield* new ConnectionTransientError({
            reason: "timeout",
            detail: `${target.label} did not respond to a connection health check.`,
          });
        }
        if (event._tag === "ProbeCompleted") {
          if (Exit.isSuccess(event.exit)) yield* Ref.set(probeUnanswered, false);
          yield* event.exit;
          break;
        }
        if (event.signal._tag === "DisconnectRequested") {
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
        Effect.map((exit) => ({ _tag: "Completed" as const, exit })),
      ),
      waitForEstablishmentInterrupt.pipe(Effect.as({ _tag: "Interrupted" as const })),
      Effect.sleep(ESTABLISHMENT_TIMEOUT).pipe(Effect.as({ _tag: "TimedOut" as const })),
    ]);

    if (establishment._tag === "Interrupted") {
      return { _tag: "Interrupted", established: false, stable: false } satisfies AttemptOutcome;
    }
    if (establishment._tag === "TimedOut") {
      return {
        _tag: "Failure",
        established: false,
        stable: false,
        error: new ConnectionTransientError({
          reason: "timeout",
          detail: `${target.label} did not respond during connection setup.`,
        }),
      } satisfies AttemptOutcome;
    }
    if (Exit.isFailure(establishment.exit)) {
      return failureFromExit(target.label, establishment.exit, false, false);
    }

    const live = establishment.exit.value;
    const currentIntent = yield* Ref.get(intent);
    if (!currentIntent.desired) {
      return { _tag: "Interrupted", established: false, stable: false } satisfies AttemptOutcome;
    }

    const connectedAt = yield* Clock.currentTimeMillis;
    yield* SubscriptionRef.set(session, Option.some(live));
    yield* setState(stateFor("connected", currentIntent, { attempt, generation }));

    const connectedExit = yield* Effect.raceFirst(live.closed, monitorConnectedSession(live)).pipe(
      exitUnlessInterrupted,
    );
    const stable = (yield* Clock.currentTimeMillis) - connectedAt >= BACKOFF_RESET_AFTER_MS;
    return Exit.isSuccess(connectedExit)
      ? ({ _tag: "Interrupted", established: true, stable } satisfies AttemptOutcome)
      : failureFromExit(target.label, connectedExit, true, stable);
  }, Effect.ensuring(clearSession));

  const waitForRetrySignal = Effect.fnUntraced(function* (delayMs: number) {
    // @effect-diagnostics-next-line raceFirstWithSleepToTimeout:off -- The sleep is the retry delay (false), not a timeout around the signal loop.
    return yield* Effect.raceFirst(
      Effect.sleep(delayMs).pipe(Effect.as(false)),
      Queue.take(signals).pipe(Effect.map((next) => next._tag === "Wakeup")),
    );
  });

  const waitForSignal = Queue.take(signals).pipe(Effect.map((next) => next._tag === "Wakeup"));

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
      if (outcome._tag === "Interrupted") continue;

      if (!outcome.established) latestFailure = outcome.error;
      if (outcome.error._tag === "ConnectionBlockedError") {
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
          changed ? signal({ _tag: "NetworkChanged", network }) : Effect.void,
        ),
      ),
    ),
    Effect.forkScoped,
  );
  yield* wakeups.changes.pipe(
    Stream.runForEach((reason) => signal({ _tag: "Wakeup", reason })),
    Effect.forkScoped,
  );
  yield* run().pipe(Effect.forkScoped);
  yield* Effect.addFinalizer(() => Queue.shutdown(signals).pipe(Effect.andThen(clearSession)));

  return ConnectionSupervisor.of({
    state,
    session,
    connect: Ref.update(intent, (current) => ({ ...current, desired: true })).pipe(
      Effect.andThen(signal({ _tag: "ConnectRequested" })),
      Effect.withSpan("ConnectionSupervisor.connect"),
    ),
    disconnect: Ref.update(intent, (current) => ({ ...current, desired: false })).pipe(
      Effect.andThen(signal({ _tag: "DisconnectRequested" })),
      Effect.withSpan("ConnectionSupervisor.disconnect"),
    ),
    retryNow: Ref.set(resetRetryState, true).pipe(
      Effect.andThen(signal({ _tag: "RetryRequested" })),
      Effect.withSpan("ConnectionSupervisor.retryNow"),
    ),
  });
});

export const layer = (options?: { readonly initiallyDesired?: boolean }) =>
  Layer.effect(ConnectionSupervisor, make(options));
