import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import { WS_METHODS } from "@app/contracts";

import {
  type ConnectionAttemptError,
  ConnectionBlockedError,
  ConnectionTransientError,
  type PreparedConnection,
} from "../connection/model.ts";
import { makeWsRpcProtocolClient, type WsRpcProtocolClient } from "./protocol.ts";

const SOCKET_OPEN_TIMEOUT = "15 seconds";

type InitialConfigError = Effect.Error<
  ReturnType<WsRpcProtocolClient[typeof WS_METHODS.serverGetConfig]>
>;

/**
 * Classify the readiness probe's failures: an authorization rejection means the
 * credential this session presented will keep being rejected — blocked — while
 * transport failures are the socket's problem and stay transient.
 */
function mapInitialConfigError(error: InitialConfigError): ConnectionAttemptError {
  switch (error._tag) {
    case "EnvironmentAuthorizationError":
      return new ConnectionBlockedError({
        reason: "permission",
        detail: error.message,
      });
    case "RpcClientError":
      return new ConnectionTransientError({
        detail: error.message,
      });
  }
}

/**
 * A live RPC session bound to one open WebSocket. `client` is the typed method
 * surface; `connected` resolves once the socket handshake succeeds AND a cheap
 * `server.getConfig` round-trip proves the far side actually answers — a socket
 * that opens against a dead server never reports healthy; `closed` fails once
 * the socket drops so the supervisor can react and reconnect.
 */
export interface RpcSession {
  readonly client: WsRpcProtocolClient;
  readonly connected: Effect.Effect<void, ConnectionAttemptError>;
  readonly closed: Effect.Effect<never, ConnectionTransientError>;
}

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

    // Mint a fresh credential and build the URL for THIS attempt. A failed mint
    // fails `connect` — transient mints get backed off and retried, while a
    // rejected credential blocks the supervisor.
    const socketUrl = yield* connection.prepareSocketUrl;

    const connected = yield* Deferred.make<void, ConnectionTransientError>();
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

    // Application-level readiness probe: the config round-trip is cached so
    // repeated awaits of `connected` never refire the RPC.
    const initialSync = yield* Effect.cached(
      client[WS_METHODS.serverGetConfig]({}).pipe(
        Effect.mapError(mapInitialConfigError),
        Effect.asVoid,
        Effect.withSpan("clientRuntime.rpcSession.initialSync"),
      ),
    );

    return {
      client,
      connected: Deferred.await(connected).pipe(
        Effect.andThen(initialSync),
        Effect.asVoid,
        Effect.raceFirst(Deferred.await(disconnected)),
      ),
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
