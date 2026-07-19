import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import * as Socket from "effect/unstable/socket/Socket";

import {
  type BearerBootstrapError,
  bootstrapRemoteBearerSession,
} from "@app/client-runtime/authorization";
import {
  type ConnectionAttemptError,
  ConnectionBlockedError,
  ConnectionSupervisor,
  connectionSupervisorLayer,
  ConnectionTransientError,
  INITIAL_CONNECTION_STATE,
  type PreparedConnection,
} from "@app/client-runtime/connection";
import { request as rpcRequest, subscribe as rpcSubscribe } from "@app/client-runtime/rpc";
import type { ServerConfig, ServerLifecyclePhase } from "@app/contracts";

import { isElectron, resolveConnectionTarget } from "../env.ts";

const BOOTSTRAP_TOKEN = import.meta.env.VITE_BOOTSTRAP_TOKEN;

/**
 * Classify a failed bootstrap exchange: an explicit auth rejection means the
 * bootstrap credential itself is being refused — retrying with backoff cannot
 * fix that, so the supervisor should park (`blocked`) until the credential
 * changes. Everything else (network, timeout, bad payload) stays transient.
 */
export function mapBearerBootstrapError(error: BearerBootstrapError): ConnectionAttemptError {
  switch (error.status) {
    case 401:
      return new ConnectionBlockedError({ reason: "authentication", detail: error.detail });
    case 403:
      return new ConnectionBlockedError({ reason: "permission", detail: error.detail });
    default:
      return new ConnectionTransientError({ detail: error.detail });
  }
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
    Effect.mapError(mapBearerBootstrapError),
  );
}

/** Build the fully-formed WS URL, carrying the token as a query param. */
function socketUrl(wsBaseUrl: string, token: string): string {
  const base = wsBaseUrl.replace(/\/$/, "");
  return `${base}/ws?access_token=${encodeURIComponent(token)}`;
}

/**
 * The connection layer: the supervisor (which owns the socket + reconnect
 * loop) over the one platform seam it needs — a browser WebSocket constructor.
 * The connection target and bearer token are resolved inside EVERY attempt, so
 * a bridge whose server bootstrap is not ready yet, or a failed mint, is just
 * another transient failure the supervisor backs off from and retries — while
 * a rejected credential (401/403) blocks the loop until it changes.
 */
export function makeConnectionLayer(): Layer.Layer<ConnectionSupervisor> {
  const connection: PreparedConnection = {
    label: "server",
    prepareSocketUrl: Effect.suspend(() => {
      const target = resolveConnectionTarget();
      return obtainBearerToken(target.httpBaseUrl).pipe(
        Effect.map((token) => socketUrl(target.wsBaseUrl, token)),
      );
    }),
  };
  return connectionSupervisorLayer(connection).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
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
    serverConfig: serverConfigAtom,
    lifecycle: lifecycleAtom,
  } as const;
}

/** The app's runtime + atoms. Components import these; tests build their own. */
export const connectionRuntime: Atom.AtomRuntime<ConnectionSupervisor> =
  Atom.runtime(makeConnectionLayer());

export const connectionAtoms = createConnectionAtoms(connectionRuntime);
