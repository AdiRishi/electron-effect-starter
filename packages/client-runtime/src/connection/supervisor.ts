import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as Socket from "effect/unstable/socket/Socket";

import * as RpcSession from "../rpc/session.ts";
import {
  ConnectionTransientError,
  INITIAL_CONNECTION_STATE,
  type ConnectionAttemptError,
  type ConnectionState,
  type PreparedConnection,
} from "./model.ts";
import { Connectivity, ConnectionWakeups, type NetworkStatus } from "./platform.ts";

/**
 * Capped exponential backoff. Attempt 1 waits 1s, then 2s, 4s, 8s, capped at
 * 16s (same table as the reference). Any supervisor signal — an `online`
 * event, an app-refocus wakeup, an explicit `retryNow` — cuts the sleep short.
 */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
const MAX_RETRY_DELAY_MS = 16_000;

/**
 * The failure counter resets only after a session survives this long. A server
 * that accepts sockets and then crashes keeps escalating backoff instead of
 * being reconnected at the 1s floor forever (same constant as the reference).
 */
const BACKOFF_RESET_AFTER_MS = 30_000;

/**
 * Bounds one whole establishment (credential mint + socket open + readiness
 * round-trip). The socket layer's own open-timeout only covers the TCP/WS
 * handshake; this covers everything, so a mint or first-RPC that hangs still
 * fails the attempt (same constant as the reference).
 */
const ESTABLISHMENT_TIMEOUT_MS = 15_000;

/**
 * How long an app-refocus health probe may take before the socket is declared
 * dead and rebuilt (same constant as the reference).
 */
const PROBE_TIMEOUT_MS = 15_000;

function retryDelayMs(attemptIndex: number): number {
  const index = Math.min(attemptIndex, RETRY_DELAYS_MS.length - 1);
  // The `?? MAX` only satisfies `noUncheckedIndexedAccess`; the clamp above
  // guarantees `index` is in range, so the fallback is never taken at runtime.
  return RETRY_DELAYS_MS[index] ?? MAX_RETRY_DELAY_MS;
}

/**
 * Events that wake the supervisor out of whatever it is waiting on. Fed by the
 * platform seams (`Connectivity`, `ConnectionWakeups`) and the public
 * `retryNow`; consumed by exactly one wait at a time (the loop is sequential).
 */
type SupervisorSignal =
  | { readonly _tag: "RetryRequested" }
  | { readonly _tag: "NetworkChanged"; readonly network: NetworkStatus }
  | { readonly _tag: "Wakeup" };

/**
 * Supervises exactly one connection: connect → hold open until it drops → wait
 * (capped backoff) → reconnect, forever. Consumers observe two `SubscriptionRef`s:
 *
 * - `state`: the coarse phase + attempt count the UI renders.
 * - `session`: `Some(session)` while a socket is live, `None` otherwise. RPC
 *   subscriptions watch this to auto-re-attach across reconnects (see `client.ts`).
 *
 * Beyond the basic loop it mirrors the reference supervisor's liveness
 * machinery: it parks while the platform reports `offline` and reconnects the
 * moment the network returns, parks on a `ConnectionBlockedError` (bad
 * credential — retrying can't fix it) until `retryNow`, health-probes the
 * socket on app-refocus to catch half-open connections, and lets any signal
 * cut a pending backoff sleep short.
 */
export class ConnectionSupervisor extends Context.Service<
  ConnectionSupervisor,
  {
    readonly state: SubscriptionRef.SubscriptionRef<ConnectionState>;
    readonly session: SubscriptionRef.SubscriptionRef<Option.Option<RpcSession.RpcSession>>;
    /** Cut any backoff or blocked park short and re-attempt now. */
    readonly retryNow: Effect.Effect<void>;
  }
>()("@app/client-runtime/connection/ConnectionSupervisor") {}

/** One connect attempt's outcome, as seen by the loop. */
type AttemptOutcome =
  /** A signal (offline / retryNow) recycled the attempt — no backoff, re-check now. */
  | { readonly _tag: "Recycle"; readonly established: boolean }
  | { readonly _tag: "Blocked"; readonly detail: string }
  | {
      readonly _tag: "Failure";
      readonly detail: string;
      /** The session survived long enough to reset the failure streak. */
      readonly stable: boolean;
      readonly established: boolean;
    };

/**
 * Convert a failure into a value, but let interruption stay interruption —
 * a supervisor being torn down must not treat its own interrupt as a failed
 * connection attempt (same helper as the reference).
 */
const exitUnlessInterrupted = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Exit.Exit<A, E>, never, R> =>
  Effect.matchCauseEffect(effect, {
    onFailure: (cause) =>
      Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(Exit.failCause(cause)),
    onSuccess: (value) => Effect.succeed(Exit.succeed(value)),
  });

/** Extract the typed attempt error from a failure cause, or synthesize one. */
function attemptErrorFromCause(
  label: string,
  cause: Cause.Cause<ConnectionAttemptError>,
): ConnectionAttemptError {
  const failure = cause.reasons.find(Cause.isFailReason);
  if (failure !== undefined) {
    return failure.error;
  }
  return new ConnectionTransientError({
    detail: `${label} connection attempt failed unexpectedly.`,
  });
}

interface SupervisorInternals {
  readonly supervisor: ConnectionSupervisor["Service"];
  readonly connection: PreparedConnection;
  readonly signals: Queue.Queue<SupervisorSignal>;
  readonly network: Ref.Ref<NetworkStatus>;
}

/**
 * The supervision loop for one `PreparedConnection`. Runs until interrupted.
 */
const runLoop = (
  internals: SupervisorInternals,
): Effect.Effect<never, never, Socket.WebSocketConstructor> =>
  Effect.gen(function* () {
    const { connection, network, signals, supervisor } = internals;
    const sessions = yield* RpcSession.RpcSessionFactory;

    /** Block until any signal arrives (park states: offline, blocked). */
    const waitForSignal = Queue.take(signals).pipe(Effect.asVoid);

    /** Sleep the backoff delay, but let any signal cut it short. */
    const waitForRetrySignal = (delayMs: number) =>
      Effect.raceFirst(Effect.sleep(delayMs), waitForSignal);

    /**
     * During establishment: abort the attempt when the network goes away or a
     * retry is explicitly requested (the loop then re-checks immediately with
     * fresh credentials). Wakeups and online transitions are irrelevant while
     * already connecting.
     */
    const waitForEstablishmentInterrupt = Effect.gen(function* () {
      for (;;) {
        const next = yield* Queue.take(signals);
        if (next._tag === "RetryRequested") return;
        if (next._tag === "NetworkChanged" && next.network === "offline") return;
      }
    });

    /**
     * While connected: watch for signals that should recycle the session, and
     * health-probe on app-refocus. Returning recycles the connection cleanly;
     * a raised error (probe failure/timeout) recycles it as a failure. Runs
     * raced against `session.closed`, so a real socket drop still wins.
     */
    const monitorConnected = (
      active: RpcSession.RpcSession,
    ): Effect.Effect<void, ConnectionAttemptError> =>
      Effect.gen(function* () {
        for (;;) {
          const next = yield* Queue.take(signals);
          if (next._tag === "RetryRequested") return;
          if (next._tag === "NetworkChanged" && next.network === "offline") return;
          if (next._tag === "Wakeup") {
            // The one moment a half-open socket betrays itself: the app came
            // back to the foreground after (possibly) a sleep/network change.
            // A socket that can't answer within the timeout is declared dead.
            yield* active.probe.pipe(
              Effect.timeoutOrElse({
                duration: PROBE_TIMEOUT_MS,
                orElse: () =>
                  Effect.fail(
                    new ConnectionTransientError({
                      detail: `${connection.label} did not respond to a connection health check.`,
                    }),
                  ),
              }),
            );
          }
        }
      });

    /** One scoped connect attempt: establish (bounded), then hold open. */
    const runAttempt: Effect.Effect<
      AttemptOutcome,
      never,
      Scope.Scope | Socket.WebSocketConstructor
    > = Effect.gen(function* () {
      const establishment = yield* Effect.raceAllFirst([
        exitUnlessInterrupted(
          Effect.gen(function* () {
            const active = yield* sessions.connect(connection);
            yield* active.ready;
            return active;
          }),
        ).pipe(Effect.map((exit) => ({ _tag: "Completed", exit }) as const)),
        waitForEstablishmentInterrupt.pipe(Effect.as({ _tag: "Interrupted" } as const)),
        Effect.sleep(ESTABLISHMENT_TIMEOUT_MS).pipe(Effect.as({ _tag: "TimedOut" } as const)),
      ]);

      if (establishment._tag === "Interrupted") {
        return { _tag: "Recycle", established: false } satisfies AttemptOutcome;
      }
      if (establishment._tag === "TimedOut") {
        return {
          _tag: "Failure",
          detail: `${connection.label} did not respond during connection setup.`,
          stable: false,
          established: false,
        } satisfies AttemptOutcome;
      }
      if (Exit.isFailure(establishment.exit)) {
        const error = attemptErrorFromCause(connection.label, establishment.exit.cause);
        return error._tag === "ConnectionBlockedError"
          ? ({ _tag: "Blocked", detail: error.detail } satisfies AttemptOutcome)
          : ({
              _tag: "Failure",
              detail: error.detail,
              stable: false,
              established: false,
            } satisfies AttemptOutcome);
      }

      const active = establishment.exit.value;
      // The network may have vanished between establishment and now.
      if ((yield* Ref.get(network)) === "offline") {
        return { _tag: "Recycle", established: true } satisfies AttemptOutcome;
      }

      const connectedAtMs = yield* Clock.currentTimeMillis;
      yield* SubscriptionRef.set(supervisor.session, Option.some(active));
      yield* SubscriptionRef.set(supervisor.state, {
        phase: "connected",
        attempt: 0,
        lastError: null,
      });

      // Hold until the socket drops (`closed` fails), the monitor recycles it
      // (returns), or a probe declares it dead (monitor fails).
      const held = yield* exitUnlessInterrupted(
        Effect.raceFirst(active.closed, monitorConnected(active)),
      );

      const uptimeMs = (yield* Clock.currentTimeMillis) - connectedAtMs;
      const stable = uptimeMs >= BACKOFF_RESET_AFTER_MS;
      if (Exit.isSuccess(held)) {
        // Monitor asked for a recycle (retryNow / offline): not a failure.
        return { _tag: "Recycle", established: true } satisfies AttemptOutcome;
      }
      const error = attemptErrorFromCause(connection.label, held.cause);
      return error._tag === "ConnectionBlockedError"
        ? ({ _tag: "Blocked", detail: error.detail } satisfies AttemptOutcome)
        : ({
            _tag: "Failure",
            detail: error.detail,
            stable,
            established: true,
          } satisfies AttemptOutcome);
    }).pipe(
      // The session ref must clear whenever the attempt's scope dies, whatever
      // the reason — the next loop iteration starts from "no session".
      Effect.ensuring(SubscriptionRef.set(supervisor.session, Option.none())),
    );

    let failureCount = 0;
    let everConnected = false;

    for (;;) {
      if ((yield* Ref.get(network)) === "offline") {
        yield* SubscriptionRef.set(supervisor.state, {
          phase: "offline",
          attempt: failureCount,
          lastError: null,
        });
        yield* waitForSignal;
        continue;
      }

      yield* SubscriptionRef.set(supervisor.state, {
        phase: everConnected ? "reconnecting" : "connecting",
        attempt: failureCount + 1,
        lastError: null,
      });

      const outcome = yield* Effect.scoped(runAttempt);

      switch (outcome._tag) {
        case "Recycle": {
          if (outcome.established) {
            everConnected = true;
          }
          continue;
        }
        case "Blocked": {
          yield* SubscriptionRef.set(supervisor.state, {
            phase: "blocked",
            attempt: failureCount + 1,
            lastError: outcome.detail,
          });
          // No auto-retry: the failure is not transient. Any signal (an
          // explicit retryNow, a network change, a wakeup) re-attempts, in
          // case credentials or configuration changed in the meantime.
          yield* waitForSignal;
          continue;
        }
        case "Failure": {
          if (outcome.established) {
            everConnected = true;
          }
          // Backoff only resets after a *stable* session — a crash-flapping
          // server (accepts the socket, dies moments later) keeps escalating
          // toward the 16s cap instead of being hammered at the 1s floor.
          if (outcome.stable) {
            failureCount = 0;
          }
          failureCount += 1;
          const delayMs = retryDelayMs(failureCount - 1);
          yield* SubscriptionRef.set(supervisor.state, {
            phase: everConnected ? "reconnecting" : "connecting",
            attempt: failureCount,
            lastError: outcome.detail,
          });
          yield* waitForRetrySignal(delayMs);
          continue;
        }
      }
    }
  });

/**
 * Build a supervisor for one connection and fork its loop into the current
 * scope. The loop (and its socket) is torn down when the scope closes.
 */
export const start = (
  connection: PreparedConnection,
): Effect.Effect<
  ConnectionSupervisor["Service"],
  never,
  Scope.Scope | Socket.WebSocketConstructor
> =>
  Effect.gen(function* () {
    const connectivity = yield* Connectivity;
    const wakeups = yield* ConnectionWakeups;

    const state = yield* SubscriptionRef.make<ConnectionState>(INITIAL_CONNECTION_STATE);
    const session = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
      Option.none(),
    );
    const signals = yield* Queue.unbounded<SupervisorSignal>();
    const network = yield* Ref.make<NetworkStatus>(yield* connectivity.status);

    const supervisor = ConnectionSupervisor.of({
      state,
      session,
      retryNow: Queue.offer(signals, { _tag: "RetryRequested" }).pipe(Effect.asVoid),
    });

    // Shutting the queue down unblocks any in-flight `take` when the scope
    // closes; the loop fiber itself is interrupted by its own fork finalizer.
    yield* Effect.addFinalizer(() => Queue.shutdown(signals));

    // Track network status continuously (deduplicated), waking the loop on
    // every real transition.
    yield* connectivity.changes.pipe(
      Stream.runForEach((next) =>
        Ref.modify(network, (current) =>
          current === next ? ([false, current] as const) : ([true, next] as const),
        ).pipe(
          Effect.flatMap((changed) =>
            changed
              ? Queue.offer(signals, { _tag: "NetworkChanged", network: next }).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ),
      Effect.forkScoped,
    );
    yield* wakeups.changes.pipe(
      Stream.runForEach(() => Queue.offer(signals, { _tag: "Wakeup" })),
      Effect.forkScoped,
    );

    yield* Effect.forkScoped(runLoop({ supervisor, connection, signals, network }));
    return supervisor;
  });

/**
 * A `Layer` that supervises `connection` and provides `ConnectionSupervisor` to
 * the rest of the runtime — so `request`/`subscribe` resolve the same instance.
 */
export const layer = (
  connection: PreparedConnection,
): Layer.Layer<ConnectionSupervisor, never, Socket.WebSocketConstructor> =>
  Layer.effect(ConnectionSupervisor, start(connection));
