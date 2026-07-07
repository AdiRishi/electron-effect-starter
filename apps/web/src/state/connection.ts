import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import * as Socket from "effect/unstable/socket/Socket";

import { bootstrapRemoteBearerSession } from "@app/client-runtime/authorization";
import {
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
 * Obtain a bearer token (integration contract):
 * - In the shell: ask the bridge.
 * - In the browser: POST the bootstrap credential and read `access_token`.
 */
function obtainBearerToken(httpBaseUrl: string): Effect.Effect<string, Error> {
  if (isElectron && window.desktopBridge) {
    const bridge = window.desktopBridge;
    return Effect.tryPromise({
      try: () => bridge.getBearerToken(),
      catch: (cause) => new Error(`Bridge failed to mint a bearer token: ${String(cause)}`),
    });
  }
  return bootstrapRemoteBearerSession({
    httpBaseUrl,
    credential: BOOTSTRAP_TOKEN,
    clientMetadata: { label: "web", deviceType: "web" },
  }).pipe(
    Effect.map((session) => session.access_token),
    Effect.mapError((error) => new Error(error.message)),
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
 * another transient failure the supervisor backs off from and retries.
 */
export function makeConnectionLayer(): Layer.Layer<ConnectionSupervisor> {
  const connection: PreparedConnection = {
    label: "server",
    prepareSocketUrl: Effect.suspend(() => {
      const target = resolveConnectionTarget();
      return obtainBearerToken(target.httpBaseUrl).pipe(
        Effect.map((token) => socketUrl(target.wsBaseUrl, token)),
        Effect.mapError((error) => new ConnectionTransientError({ detail: error.message })),
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

  // Live streams. The client-runtime subscription watches the session ref and
  // re-attaches across reconnects by itself, so these atoms subscribe once for
  // as long as they stay mounted.
  const tickResultAtom = runtime.atom(
    rpcSubscribe("server.subscribeTicks", {}).pipe(Stream.map((event) => event.tick)),
  );

  const lifecycleResultAtom = runtime.atom(
    rpcSubscribe("server.subscribeLifecycle", {}).pipe(Stream.map((event) => event.phase)),
  );

  const tickAtom = Atom.make((get): number | null =>
    Option.getOrNull(AsyncResult.value(get(tickResultAtom))),
  ).pipe(Atom.withLabel("server-tick"));

  const lifecycleAtom = Atom.make((get): ServerLifecyclePhase | null =>
    Option.getOrNull(AsyncResult.value(get(lifecycleResultAtom))),
  ).pipe(Atom.withLabel("server-lifecycle"));

  /** Imperative echo call; consumers read the `AsyncResult` for pending/result. */
  const echoAtom = runtime.fn((input: { readonly message: string }) =>
    rpcRequest("server.echo", input),
  );

  return {
    state: stateAtom,
    serverConfig: serverConfigAtom,
    tick: tickAtom,
    lifecycle: lifecycleAtom,
    echo: echoAtom,
  } as const;
}

/** The app's runtime + atoms. Components import these; tests build their own. */
export const connectionRuntime: Atom.AtomRuntime<ConnectionSupervisor> =
  Atom.runtime(makeConnectionLayer());

export const connectionAtoms = createConnectionAtoms(connectionRuntime);
