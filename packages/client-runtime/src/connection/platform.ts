import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * Platform seams the supervisor listens to. Both are `Context.Reference`s with
 * inert defaults (network unknown, no wakeups), so the supervisor works
 * unwired — in a browser the web app provides real implementations backed by
 * `navigator.onLine` + `online`/`offline` events and `visibilitychange`.
 *
 * @module connection/platform
 */

export type NetworkStatus = "unknown" | "online" | "offline";

export interface ConnectivityShape {
  readonly status: Effect.Effect<NetworkStatus>;
  readonly changes: Stream.Stream<NetworkStatus>;
}

/**
 * Network reachability as the platform reports it. While `offline` the
 * supervisor parks instead of burning attempts; the `online` transition
 * reconnects immediately instead of waiting out a backoff sleep.
 */
export const Connectivity = Context.Reference<ConnectivityShape>(
  "@app/client-runtime/connection/Connectivity",
  {
    defaultValue: (): ConnectivityShape => ({
      status: Effect.succeed("unknown"),
      changes: Stream.empty,
    }),
  },
);

/** Why the supervisor is being woken: the app came back to the foreground. */
export type ConnectionWakeup = "application-active";

export interface ConnectionWakeupsShape {
  readonly changes: Stream.Stream<ConnectionWakeup>;
}

/**
 * Moments the platform believes the connection deserves a fresh look. On
 * `application-active` (tab refocus / window foreground) a *connected*
 * supervisor health-probes the socket — the only way to detect a half-open
 * TCP connection that will never emit a close frame (laptop sleep, silent
 * network drop) — and a waiting supervisor re-checks immediately.
 */
export const ConnectionWakeups = Context.Reference<ConnectionWakeupsShape>(
  "@app/client-runtime/connection/ConnectionWakeups",
  {
    defaultValue: (): ConnectionWakeupsShape => ({
      changes: Stream.empty,
    }),
  },
);
