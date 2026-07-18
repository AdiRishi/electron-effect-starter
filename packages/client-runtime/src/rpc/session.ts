import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import type { RpcClientError } from "effect/unstable/rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import { WS_METHODS, type EnvironmentAuthorizationError } from "@app/contracts";

import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionAttemptError,
  type PreparedConnection,
} from "../connection/model.ts";
import { makeWsRpcProtocolClient, type WsRpcProtocolClient } from "./protocol.ts";

const SOCKET_OPEN_TIMEOUT = "15 seconds";

/**
 * A live RPC session bound to one open WebSocket. `client` is the typed method
 * surface; `ready` resolves once the socket handshake succeeded AND the first
 * RPC round-trip (`server.getConfig`) came back — a socket that opens but can't
 * serve requests never becomes "ready", so the supervisor keeps treating it as
 * a failed attempt instead of declaring a dead connection healthy. `probe` is a
 * cheap liveness check over the same RPC (used on app-refocus to catch half-open
 * sockets); `closed` fails once the socket drops so the supervisor can react.
 */
export interface RpcSession {
  readonly client: WsRpcProtocolClient;
  readonly ready: Effect.Effect<void, ConnectionAttemptError>;
  readonly probe: Effect.Effect<void, ConnectionAttemptError>;
  readonly closed: Effect.Effect<never, ConnectionTransientError>;
}

/**
 * The handshake/probe RPC shares the supervisor's error vocabulary: a server
 * that answers "unauthorized" is a blocked (park, don't retry) failure, while
 * a transport hiccup stays transient.
 */
const mapHandshakeError = (
  label: string,
): ((
  error: EnvironmentAuthorizationError | RpcClientError.RpcClientError,
) => ConnectionAttemptError) => {
  return (error) =>
    error._tag === "EnvironmentAuthorizationError"
      ? new ConnectionBlockedError({ reason: "authentication", detail: error.message })
      : new ConnectionTransientError({ detail: `${label}: ${error.message}` });
};

/**
 * Open a socket to `connection.socketUrl` and build the typed RPC client. The
 * returned session is scoped: its socket closes when the enclosing scope closes.
 *
 * Retries are disabled at the protocol layer — reconnection is the supervisor's
 * job (it rebuilds a whole fresh session), so a session is single-use.
 */
export const connect = (
  connection: PreparedConnection,
): Effect.Effect<RpcSession, ConnectionAttemptError, Scope.Scope | Socket.WebSocketConstructor> =>
  Effect.gen(function* () {
    const webSocketConstructor = yield* Socket.WebSocketConstructor;

    // Mint fresh credentials and build the URL for THIS attempt. A failed mint
    // fails `connect`, which the supervisor treats as an attempt failure.
    const socketUrl = yield* connection.prepareSocketUrl;

    const connected = yield* Deferred.make<void>();
    const disconnected = yield* Deferred.make<never, ConnectionTransientError>();

    const hooks = RpcClient.ConnectionHooks.of({
      onConnect: Deferred.succeed(connected, undefined).pipe(Effect.asVoid),
      onDisconnect: Deferred.isDone(connected).pipe(
        Effect.flatMap((wasConnected) =>
          Deferred.fail(
            disconnected,
            new ConnectionTransientError({
              detail: wasConnected
                ? `${connection.label} disconnected.`
                : `${connection.label} could not establish a WebSocket connection.`,
            }),
          ),
        ),
        Effect.asVoid,
      ),
    });

    const socketLayer = Socket.layerWebSocket(socketUrl, {
      openTimeout: SOCKET_OPEN_TIMEOUT,
    }).pipe(Layer.provide(Layer.succeed(Socket.WebSocketConstructor, webSocketConstructor)));

    const protocolLayer = Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({
        retryTransientErrors: false,
        retryPolicy: Schedule.recurs(0),
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          socketLayer,
          RpcSerialization.layerJson,
          Layer.succeed(RpcClient.ConnectionHooks, hooks),
        ),
      ),
    );

    const protocolContext = yield* Layer.build(protocolLayer).pipe(
      Effect.withSpan("clientRuntime.websocket.connect"),
    );
    const client = yield* makeWsRpcProtocolClient.pipe(Effect.provide(protocolContext));

    const toAttemptError = mapHandshakeError(connection.label);

    // Cached: `ready` runs it once per session; later subscribers share the
    // result instead of issuing a duplicate round-trip.
    const initialSync = yield* Effect.cached(
      client[WS_METHODS.serverGetConfig]({}).pipe(
        Effect.mapError(toAttemptError),
        Effect.asVoid,
        Effect.withSpan("clientRuntime.rpc.initialSync"),
      ),
    );

    const probe = client[WS_METHODS.serverGetConfig]({}).pipe(
      Effect.mapError(toAttemptError),
      Effect.asVoid,
      Effect.withSpan("clientRuntime.rpc.probe"),
    );

    return {
      client,
      // Socket open → first round-trip, the whole handshake raced against the
      // socket dropping mid-way so `ready` can't hang on a dead session.
      ready: Deferred.await(connected).pipe(
        Effect.andThen(initialSync),
        Effect.raceFirst(Deferred.await(disconnected)),
      ),
      probe,
      closed: Deferred.await(disconnected),
    } satisfies RpcSession;
  });

export interface RpcSessionFactoryShape {
  readonly connect: (
    connection: PreparedConnection,
  ) => Effect.Effect<RpcSession, ConnectionAttemptError, Scope.Scope | Socket.WebSocketConstructor>;
}

/**
 * How the supervisor obtains sessions. Defaults to the real WebSocket
 * `connect`, so app wiring stays zero-config; tests override it with scripted
 * sessions to drive connect/drop/backoff deterministically (the same seam the
 * reference repo models as its `RpcSessionFactory` service).
 */
export const RpcSessionFactory = Context.Reference<RpcSessionFactoryShape>(
  "@app/client-runtime/rpc/RpcSessionFactory",
  { defaultValue: () => ({ connect }) },
);
