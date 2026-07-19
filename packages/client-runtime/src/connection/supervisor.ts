import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Socket from "effect/unstable/socket/Socket";

import * as RpcSession from "../rpc/session.ts";
import {
  type ConnectionAttemptError,
  type ConnectionState,
  ConnectionTransientError,
  INITIAL_CONNECTION_STATE,
  type PreparedConnection,
} from "./model.ts";

/**
 * Capped exponential backoff. Attempt 1 waits 1s, then 2s, 4s, 8s, capped at
 * 16s. A tiny table keeps the "simple" promise of this starter's supervisor.
 */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
const MAX_RETRY_DELAY_MS = 16_000;

/**
 * Bounds the whole establishment phase (connect + readiness probe). The socket
 * layer's own open-timeout only bounds the raw open; a socket that opens but
 * whose readiness probe hangs would otherwise freeze the loop forever.
 */
const CONNECTION_ESTABLISHMENT_TIMEOUT = "15 seconds";

/**
 * The failure counter resets only after a session survives this long. A server
 * that accepts sockets and then crashes keeps escalating backoff instead of
 * being reconnected at the 1s floor forever (same constant as the reference).
 */
const BACKOFF_RESET_AFTER_MS = 30_000;

function retryDelayMs(attemptIndex: number): number {
  const index = Math.min(attemptIndex, RETRY_DELAYS_MS.length - 1);
  // The `?? MAX` only satisfies `noUncheckedIndexedAccess`; the clamp above
  // guarantees `index` is in range, so the fallback is never taken at runtime.
  return RETRY_DELAYS_MS[index] ?? MAX_RETRY_DELAY_MS;
}

/**
 * Collapse any non-interrupt cause into a `ConnectionAttemptError` the loop can
 * act on. A typed failure passes through as-is — transient OR blocked. Pure
 * interrupts are re-raised so closing the enclosing scope still tears the loop
 * down cleanly; unexpected defects are logged and synthesized into a transient
 * failure instead of killing the supervisor fiber (defects are never blocking).
 */
const failureFromCause = (
  connection: PreparedConnection,
  cause: Cause.Cause<ConnectionAttemptError>,
): Effect.Effect<ConnectionAttemptError> =>
  Effect.gen(function* () {
    if (Cause.hasInterruptsOnly(cause)) {
      return yield* Effect.interrupt;
    }
    const typedFailure = cause.reasons.find(Cause.isFailReason);
    if (typedFailure !== undefined) {
      return typedFailure.error;
    }
    yield* Effect.logError("Connection attempt failed with an unexpected defect.", {
      cause: Cause.pretty(cause),
    });
    return new ConnectionTransientError({
      detail: `${connection.label} connection failed unexpectedly.`,
    });
  });

/**
 * Supervises exactly one connection: connect → hold open until it drops → wait
 * (capped backoff) → reconnect, forever. A blocked failure parks the loop
 * instead: it publishes `blocked` and waits for `retryNow` before attempting
 * again. Consumers observe two `SubscriptionRef`s:
 *
 * - `state`: the coarse phase + attempt count the UI renders.
 * - `session`: `Some(session)` while a socket is live, `None` otherwise. RPC
 *   subscriptions watch this to auto-re-attach across reconnects (see `client.ts`).
 */
export class ConnectionSupervisor extends Context.Service<
  ConnectionSupervisor,
  {
    readonly state: SubscriptionRef.SubscriptionRef<ConnectionState>;
    readonly session: SubscriptionRef.SubscriptionRef<Option.Option<RpcSession.RpcSession>>;
    /**
     * Wake a `blocked` supervisor for an immediate fresh attempt — call it
     * after whatever blocked the connection (credentials, configuration) has
     * changed. A no-op unless the loop is parked.
     */
    readonly retryNow: Effect.Effect<void>;
  }
>()("@app/client-runtime/connection/ConnectionSupervisor") {}

/**
 * The supervision loop for one `PreparedConnection`. Runs until interrupted. On
 * every drop it publishes `reconnecting`, sleeps with capped backoff, and
 * rebuilds a fresh session from scratch.
 */
const runLoop = (
  supervisor: ConnectionSupervisor["Service"],
  connection: PreparedConnection,
  parked: Ref.Ref<Option.Option<Deferred.Deferred<void>>>,
): Effect.Effect<never, never, Socket.WebSocketConstructor> =>
  Effect.gen(function* () {
    const sessions = yield* RpcSession.RpcSessionFactory;
    let failureCount = 0;
    let everConnected = false;

    for (;;) {
      yield* SubscriptionRef.set(supervisor.state, {
        phase: everConnected ? "reconnecting" : "connecting",
        attempt: failureCount + 1,
        lastError: null,
      });

      // Set once the socket is up, so the drop below can measure uptime.
      let connectedAtMs: number | null = null;

      // The inner program never succeeds — it either fails to connect or holds
      // open until the socket drops (both surface a `ConnectionTransientError`).
      // Handle the FULL cause (not just the typed failure) so a defect from the
      // session can never escape the loop and kill the supervisor fiber.
      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          // Establishment (connect + readiness probe) is bounded as a whole; a
          // hung probe against an open-but-dead socket cannot freeze the loop.
          const active = yield* Effect.gen(function* () {
            const session = yield* sessions.connect(connection);
            yield* session.connected;
            return session;
          }).pipe(
            Effect.timeoutOrElse({
              duration: CONNECTION_ESTABLISHMENT_TIMEOUT,
              orElse: () =>
                Effect.fail(
                  new ConnectionTransientError({
                    detail: `${connection.label} did not respond during connection setup.`,
                  }),
                ),
            }),
          );
          everConnected = true;
          connectedAtMs = yield* Clock.currentTimeMillis;
          yield* SubscriptionRef.set(supervisor.session, Option.some(active));
          yield* SubscriptionRef.set(supervisor.state, {
            phase: "connected",
            attempt: 0,
            lastError: null,
          });
          // Block here until the socket drops; `closed` fails with the reason.
          return yield* active.closed;
        }),
      ).pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) => failureFromCause(connection, cause),
          onSuccess: Effect.succeed,
        }),
      );

      // The session scope has closed, so clear it before backing off.
      yield* SubscriptionRef.set(supervisor.session, Option.none());

      // A blocked failure never feeds the backoff schedule: publish `blocked`,
      // park until an external signal (`retryNow`) reports that whatever
      // blocked us changed, then loop straight into a fresh attempt. The
      // resume deferred is registered BEFORE the state is published, so any
      // observer that has seen `blocked` can already wake the loop.
      if (outcome._tag === "ConnectionBlockedError") {
        const resume = yield* Deferred.make<void>();
        yield* Ref.set(parked, Option.some(resume));
        yield* SubscriptionRef.set(supervisor.state, {
          phase: "blocked",
          attempt: failureCount + 1,
          lastError: outcome.detail,
        });
        yield* Deferred.await(resume);
        yield* Ref.set(parked, Option.none());
        continue;
      }

      // Backoff only resets after a *stable* session — a crash-flapping server
      // (accepts the socket, dies moments later) keeps escalating toward the
      // 16s cap instead of being hammered at the 1s floor.
      if (connectedAtMs !== null) {
        const uptimeMs = (yield* Clock.currentTimeMillis) - connectedAtMs;
        if (uptimeMs >= BACKOFF_RESET_AFTER_MS) {
          failureCount = 0;
        }
      }

      failureCount += 1;
      const delayMs = retryDelayMs(failureCount - 1);
      yield* SubscriptionRef.set(supervisor.state, {
        phase: "reconnecting",
        attempt: failureCount,
        lastError: outcome.detail,
      });
      yield* Effect.sleep(delayMs);
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
    const state = yield* SubscriptionRef.make<ConnectionState>(INITIAL_CONNECTION_STATE);
    const session = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
      Option.none(),
    );
    const parked = yield* Ref.make(Option.none<Deferred.Deferred<void>>());
    const retryNow = Ref.get(parked).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (resume) => Deferred.succeed(resume, undefined).pipe(Effect.asVoid),
        }),
      ),
    );
    const supervisor = ConnectionSupervisor.of({ state, session, retryNow });
    yield* Effect.forkScoped(runLoop(supervisor, connection, parked));
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
