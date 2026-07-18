import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import * as Socket from "effect/unstable/socket/Socket";

import {
  bootstrapRemoteBearerSession,
  issueWebSocketTicket,
  type AuthorizationRequestError,
} from "@app/client-runtime/authorization";
import {
  ConnectionBlockedError,
  ConnectionSupervisor,
  connectionSupervisorLayer,
  ConnectionTransientError,
  Connectivity,
  ConnectionWakeups,
  INITIAL_CONNECTION_STATE,
  type ConnectionAttemptError,
  type ConnectionWakeupsShape,
  type ConnectivityShape,
  type NetworkStatus,
  type PreparedConnection,
} from "@app/client-runtime/connection";
import { request as rpcRequest, subscribe as rpcSubscribe } from "@app/client-runtime/rpc";
import type { ServerConfig, ServerLifecyclePhase } from "@app/contracts";

import { isElectron, resolveConnectionTarget } from "../env.ts";

const BOOTSTRAP_TOKEN = import.meta.env.VITE_BOOTSTRAP_TOKEN;

/**
 * A rejected credential (401/403) becomes a blocked failure — the supervisor
 * parks and the UI says "not authorized" instead of retrying forever. Anything
 * else (server unreachable, timeout, undecodable response) stays transient.
 */
function toConnectionError(error: AuthorizationRequestError): ConnectionAttemptError {
  return error.isRejected
    ? new ConnectionBlockedError({ reason: "authentication", detail: error.message })
    : new ConnectionTransientError({ detail: error.message });
}

/**
 * Obtain a bearer token (integration contract):
 * - In the shell: ask the bridge.
 * - In the browser: POST the bootstrap credential and read `access_token`.
 */
function obtainBearerToken(httpBaseUrl: string): Effect.Effect<string, ConnectionAttemptError> {
  if (isElectron && window.desktopBridge) {
    const bridge = window.desktopBridge;
    return Effect.tryPromise({
      try: () => bridge.getBearerToken(),
      catch: (cause) =>
        new ConnectionTransientError({
          detail: `Bridge failed to mint a bearer token: ${String(cause)}`,
        }),
    });
  }
  return bootstrapRemoteBearerSession({
    httpBaseUrl,
    credential: BOOTSTRAP_TOKEN,
    clientMetadata: { label: "web", deviceType: "web" },
  }).pipe(
    Effect.map((session) => session.access_token),
    Effect.mapError(toConnectionError),
  );
}

/** Build the fully-formed WS URL, carrying the short-lived ticket as a query param. */
function socketUrl(wsBaseUrl: string, ticket: string): string {
  const base = wsBaseUrl.replace(/\/$/, "");
  return `${base}/ws?wsTicket=${encodeURIComponent(ticket)}`;
}

function currentNetworkStatus(): NetworkStatus {
  if (typeof navigator === "undefined") {
    return "unknown";
  }
  return navigator.onLine ? "online" : "offline";
}

/** `navigator.onLine` + `online`/`offline` events → the supervisor's network seam. */
const browserConnectivity: ConnectivityShape = {
  status: Effect.sync(currentNetworkStatus),
  changes:
    typeof window === "undefined"
      ? Stream.empty
      : Stream.callback<NetworkStatus>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const online = () => Queue.offerUnsafe(queue, "online");
              const offline = () => Queue.offerUnsafe(queue, "offline");
              window.addEventListener("online", online);
              window.addEventListener("offline", offline);
              return { online, offline };
            }),
            ({ offline, online }) =>
              Effect.sync(() => {
                window.removeEventListener("online", online);
                window.removeEventListener("offline", offline);
              }),
          ).pipe(Effect.asVoid),
        ),
};

/** Tab-refocus → app-active wakeups, so the supervisor health-probes the socket. */
const browserWakeups: ConnectionWakeupsShape = {
  changes:
    typeof document === "undefined"
      ? Stream.empty
      : Stream.callback<"application-active">((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const listener = () => {
                if (document.visibilityState === "visible") {
                  Queue.offerUnsafe(queue, "application-active");
                }
              };
              document.addEventListener("visibilitychange", listener);
              return listener;
            }),
            (listener) =>
              Effect.sync(() => {
                document.removeEventListener("visibilitychange", listener);
              }),
          ).pipe(Effect.asVoid),
        ),
};

/**
 * The connection layer: the supervisor (which owns the socket + reconnect
 * loop) over its platform seams — the browser WebSocket constructor, network
 * status, and tab-visibility wakeups. Credentials are resolved inside EVERY
 * attempt (bearer → short-lived WS ticket → URL), so a bridge whose server
 * bootstrap is not ready yet, or a failed mint, is just another attempt
 * failure; a *rejected* credential parks the supervisor as `blocked`.
 */
export function makeConnectionLayer(): Layer.Layer<ConnectionSupervisor> {
  const connection: PreparedConnection = {
    label: "server",
    prepareSocketUrl: Effect.suspend(() => {
      const target = resolveConnectionTarget();
      return obtainBearerToken(target.httpBaseUrl).pipe(
        Effect.flatMap((bearer) =>
          issueWebSocketTicket({
            httpBaseUrl: target.httpBaseUrl,
            bearerToken: bearer,
          }).pipe(Effect.mapError(toConnectionError)),
        ),
        Effect.map((issued) => socketUrl(target.wsBaseUrl, issued.ticket)),
      );
    }),
  };
  return connectionSupervisorLayer(connection).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
    Layer.provide(Layer.succeed(Connectivity, browserConnectivity)),
    Layer.provide(Layer.succeed(ConnectionWakeups, browserWakeups)),
  );
}

/**
 * Build the app's atoms against an `AtomRuntime` that provides the supervisor.
 * A factory (rather than module-level atoms) so tests can instantiate the same
 * atoms over a scripted runtime — the pattern the reference repo uses for its
 * state modules.
 */
export function createConnectionAtoms<R, E>(
  runtime: Atom.AtomRuntime<ConnectionSupervisor | R, E>,
) {
  const stateResultAtom = runtime.atom(
    Stream.unwrap(
      ConnectionSupervisor.pipe(
        Effect.map((supervisor) => SubscriptionRef.changes(supervisor.state)),
      ),
    ),
    { initialValue: INITIAL_CONNECTION_STATE },
  );

  /** The coarse phase + attempt count the UI renders. Never empty. */
  const stateAtom = Atom.make((get) =>
    Option.getOrElse(AsyncResult.value(get(stateResultAtom)), () => INITIAL_CONNECTION_STATE),
  ).pipe(Atom.withLabel("connection-state"));

  /** Cut a backoff or blocked park short — the UI's "retry now" button. */
  const retryNowAtom = runtime.fn(() =>
    ConnectionSupervisor.pipe(Effect.flatMap((supervisor) => supervisor.retryNow)),
  );

  /**
   * Server config, re-fetched per session: every fresh session emits one
   * `getConfig` result (the "first request doubles as initial sync" contract),
   * and a drop clears it back to null. A failed fetch also yields null instead
   * of killing the stream, so the next reconnect still re-syncs.
   */
  const serverConfigResultAtom = runtime.atom(
    Stream.unwrap(
      ConnectionSupervisor.pipe(
        Effect.map((supervisor) =>
          SubscriptionRef.changes(supervisor.session).pipe(
            Stream.switchMap(
              Option.match({
                onNone: () => Stream.succeed(null),
                onSome: () =>
                  Stream.fromEffect(
                    rpcRequest("server.getConfig", {}).pipe(
                      Effect.option,
                      Effect.map(Option.getOrNull),
                    ),
                  ),
              }),
            ),
          ),
        ),
      ),
    ),
  );

  const serverConfigAtom = Atom.make((get): ServerConfig | null =>
    Option.getOrElse(AsyncResult.value(get(serverConfigResultAtom)), () => null),
  ).pipe(Atom.withLabel("server-config"));

  // Live lifecycle stream. The client-runtime subscription watches the session
  // ref and re-attaches across reconnects by itself, so the atom subscribes
  // once for as long as it stays mounted.
  const lifecycleResultAtom = runtime.atom(
    rpcSubscribe("server.subscribeLifecycle", {}).pipe(Stream.map((event) => event.phase)),
  );

  const lifecycleAtom = Atom.make((get): ServerLifecyclePhase | null =>
    Option.getOrNull(AsyncResult.value(get(lifecycleResultAtom))),
  ).pipe(Atom.withLabel("server-lifecycle"));

  return {
    state: stateAtom,
    retryNow: retryNowAtom,
    serverConfig: serverConfigAtom,
    lifecycle: lifecycleAtom,
  } as const;
}

/** The app's runtime + atoms. Components import these; tests build their own. */
export const connectionRuntime: Atom.AtomRuntime<ConnectionSupervisor> =
  Atom.runtime(makeConnectionLayer());

export const connectionAtoms = createConnectionAtoms(connectionRuntime);
