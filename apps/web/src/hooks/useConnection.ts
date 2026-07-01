import {
  bootstrapRemoteBearerSession,
  ConnectionSupervisor,
  connectionSupervisorLayer,
  type ConnectionState,
  ConnectionTransientError,
  INITIAL_CONNECTION_STATE,
  type PreparedConnection,
  request as rpcRequest,
  type RpcInput,
  type RpcStreamValue,
  type RpcSuccess,
  type StreamRpcTag,
  subscribe as rpcSubscribe,
  type UnaryRpcTag,
} from "@app/client-runtime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Socket from "effect/unstable/socket/Socket";
import { useCallback, useEffect, useRef, useState } from "react";

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
      catch: (cause) =>
        new Error(`Bridge failed to mint a bearer token: ${String(cause)}`),
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

// The full runtime: the supervisor (which owns the socket + reconnect loop) over
// the one platform seam it needs — a browser WebSocket constructor. The bearer
// bootstrap uses the global `fetch` directly, so no HttpClient layer is needed.
function makeRuntimeLayer(
  connection: PreparedConnection,
): Layer.Layer<ConnectionSupervisor> {
  return Layer.provideMerge(
    connectionSupervisorLayer(connection),
    Socket.layerWebSocketConstructorGlobal,
  );
}

type AppRuntime = ManagedRuntime.ManagedRuntime<ConnectionSupervisor, never>;

export interface ConnectionHandle {
  readonly state: ConnectionState;
  /** Run a unary RPC as a Promise, bound to the live runtime. */
  readonly request: <TTag extends UnaryRpcTag>(
    tag: TTag,
    input: RpcInput<TTag>,
  ) => Promise<RpcSuccess<TTag>>;
  /** Subscribe to a streaming RPC; `onValue` fires per push. Returns unsubscribe. */
  readonly subscribe: <TTag extends StreamRpcTag>(
    tag: TTag,
    input: RpcInput<TTag>,
    onValue: (value: RpcStreamValue<TTag>) => void,
  ) => () => void;
}

/**
 * Boots the connection supervisor once and mirrors its state into React.
 * Bearer-token acquisition happens INSIDE the supervisor's connect loop (via
 * `PreparedConnection.prepareSocketUrl`), so a server that is down at first load
 * is retried with backoff rather than leaving the UI stuck. `request`/`subscribe`
 * run against the same runtime, so RPCs and the status dot share one session and
 * one reconnect loop.
 */
export function useConnection(): ConnectionHandle {
  const [state, setState] = useState<ConnectionState>(INITIAL_CONNECTION_STATE);
  const runtimeRef = useRef<AppRuntime | null>(null);

  useEffect(() => {
    let disposed = false;
    const target = resolveConnectionTarget();

    // The supervisor runs `prepareSocketUrl` on every attempt: mint a bearer
    // credential, then form the ws URL. A failed mint becomes a transient error
    // it backs off from — the auth step is part of reconnection, not a gate
    // before it.
    const connection: PreparedConnection = {
      label: "server",
      prepareSocketUrl: obtainBearerToken(target.httpBaseUrl).pipe(
        Effect.map((token) => socketUrl(target.wsBaseUrl, token)),
        Effect.mapError(
          (error) => new ConnectionTransientError({ detail: error.message }),
        ),
      ),
    };

    const runtime = ManagedRuntime.make(makeRuntimeLayer(connection));
    runtimeRef.current = runtime;

    // Mirror supervisor state into React for as long as this mount lives.
    const mirrorFiber = runtime.runFork(
      Effect.gen(function* () {
        const supervisor = yield* ConnectionSupervisor;
        yield* SubscriptionRef.changes(supervisor.state).pipe(
          Stream.runForEach((next) =>
            Effect.sync(() => {
              if (!disposed) setState(next);
            }),
          ),
        );
      }),
    );

    return () => {
      disposed = true;
      runtimeRef.current = null;
      void Effect.runPromise(Fiber.interrupt(mirrorFiber));
      void runtime.dispose();
    };
  }, []);

  const request = useCallback(
    <TTag extends UnaryRpcTag>(
      tag: TTag,
      input: RpcInput<TTag>,
    ): Promise<RpcSuccess<TTag>> => {
      const runtime = runtimeRef.current;
      if (!runtime) return Promise.reject(new Error("Not connected yet."));
      return runtime.runPromise(rpcRequest(tag, input));
    },
    [],
  );

  const subscribe = useCallback(
    <TTag extends StreamRpcTag>(
      tag: TTag,
      input: RpcInput<TTag>,
      onValue: (value: RpcStreamValue<TTag>) => void,
    ): (() => void) => {
      const runtime = runtimeRef.current;
      if (!runtime) return () => {};
      const fiber = runtime.runFork(
        rpcSubscribe(tag, input).pipe(
          Stream.runForEach((value) => Effect.sync(() => onValue(value))),
        ),
      );
      return () => {
        void Effect.runPromise(Fiber.interrupt(fiber));
      };
    },
    [],
  );

  return { state, request, subscribe };
}
