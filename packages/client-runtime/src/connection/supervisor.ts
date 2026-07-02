import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Socket from "effect/unstable/socket/Socket";

import * as RpcSession from "../rpc/session.ts";
import {
  type ConnectionState,
  INITIAL_CONNECTION_STATE,
  type PreparedConnection,
} from "./model.ts";

/**
 * Capped exponential backoff. Attempt 1 waits 1s, then 2s, 4s, 8s, capped at
 * 16s. A tiny table keeps the "simple" promise of this starter's supervisor.
 */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
const MAX_RETRY_DELAY_MS = 16_000;

function retryDelayMs(attemptIndex: number): number {
  const index = Math.min(attemptIndex, RETRY_DELAYS_MS.length - 1);
  // The `?? MAX` only satisfies `noUncheckedIndexedAccess`; the clamp above
  // guarantees `index` is in range, so the fallback is never taken at runtime.
  return RETRY_DELAYS_MS[index] ?? MAX_RETRY_DELAY_MS;
}

/**
 * Supervises exactly one connection: connect → hold open until it drops → wait
 * (capped backoff) → reconnect, forever. Consumers observe two `SubscriptionRef`s:
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
): Effect.Effect<never, never, Socket.WebSocketConstructor> =>
  Effect.gen(function* () {
    let failureCount = 0;
    let everConnected = false;

    for (;;) {
      yield* SubscriptionRef.set(supervisor.state, {
        phase: everConnected ? "reconnecting" : "connecting",
        attempt: failureCount + 1,
        lastError: null,
      });

      // The inner program never succeeds — it either fails to connect or holds
      // open until the socket drops (both surface a `ConnectionTransientError`).
      // Catch that failure so the loop sees it as a value to back off from.
      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const active = yield* RpcSession.connect(connection);
          yield* active.connected;
          everConnected = true;
          failureCount = 0;
          yield* SubscriptionRef.set(supervisor.session, Option.some(active));
          yield* SubscriptionRef.set(supervisor.state, {
            phase: "connected",
            attempt: 0,
            lastError: null,
          });
          // Block here until the socket drops; `closed` fails with the reason.
          return yield* active.closed;
        }),
      ).pipe(Effect.catch(Effect.succeed));

      // The session scope has closed, so clear it before backing off.
      yield* SubscriptionRef.set(supervisor.session, Option.none());

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
    const supervisor = ConnectionSupervisor.of({ state, session });
    yield* Effect.forkScoped(runLoop(supervisor, connection));
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
