import { WS_METHODS } from "@app/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import { type ConnectionAttemptError, ConnectionTransientError } from "../connection/model.ts";
import { makeWsRpcProtocolClient, PING_TIMEOUT, type WsRpcProtocolClient } from "./protocol.ts";

const SOCKET_OPEN_TIMEOUT = "15 seconds";
const PING_TIMEOUT_SECONDS = Duration.toSeconds(PING_TIMEOUT);

/** One open WebSocket and the typed RPC client over it. It never reconnects; the supervisor does. */
export interface RpcSession {
  readonly client: WsRpcProtocolClient;
  readonly ready: Effect.Effect<void, ConnectionAttemptError>;
  readonly probe: Effect.Effect<void, ConnectionAttemptError>;
  readonly closed: Effect.Effect<never, ConnectionAttemptError>;
}

export class RpcSessionFactory extends Context.Service<
  RpcSessionFactory,
  {
    readonly connect: (input: {
      readonly label: string;
      readonly socketUrl: string;
    }) => Effect.Effect<RpcSession, ConnectionAttemptError, Scope.Scope>;
  }
>()("@app/client-runtime/rpc/session/RpcSessionFactory") {}

const make = Effect.gen(function* () {
  const webSocketConstructor = yield* Socket.WebSocketConstructor;

  // The enclosing connection attempt owns the span.
  const connect = Effect.fnUntraced(function* (input: {
    readonly label: string;
    readonly socketUrl: string;
  }) {
    const connected = yield* Deferred.make<void>();
    const disconnected = yield* Deferred.make<never, ConnectionTransientError>();
    const pingTimedOut = yield* Ref.make(false);
    const hooks = RpcClient.ConnectionHooks.of({
      onConnect: Deferred.succeed(connected, undefined).pipe(Effect.asVoid),
      onDisconnect: Effect.all([Deferred.isDone(connected), Ref.get(pingTimedOut)]).pipe(
        Effect.flatMap(([wasConnected, timedOut]) =>
          Deferred.fail(
            disconnected,
            new ConnectionTransientError({
              reason: "transport",
              detail: !wasConnected
                ? `${input.label} could not establish a WebSocket connection.`
                : timedOut
                  ? `${input.label} stopped responding for ${PING_TIMEOUT_SECONDS}s.`
                  : `${input.label} disconnected.`,
            }),
          ),
        ),
        Effect.asVoid,
      ),
    });
    const layerSocket = Socket.layerWebSocket(input.socketUrl, {
      openTimeout: SOCKET_OPEN_TIMEOUT,
    }).pipe(Layer.provide(Layer.succeed(Socket.WebSocketConstructor, webSocketConstructor)));
    // Retries stay off: exactly one component reconnects, and it is the supervisor.
    const layerProtocol = Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({
        pingTimeout: PING_TIMEOUT,
        retryTransientErrors: false,
        retryPolicy: Schedule.recurs(0),
        onPingTimeout: Ref.set(pingTimedOut, true),
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          layerSocket,
          RpcSerialization.layerJson,
          Layer.succeed(RpcClient.ConnectionHooks, hooks),
        ),
      ),
    );
    const protocolContext = yield* Layer.build(layerProtocol);
    const client = yield* makeWsRpcProtocolClient.pipe(Effect.provideContext(protocolContext));

    const probe = client[WS_METHODS.serverProbe]({}).pipe(
      Effect.mapError(
        (error) =>
          new ConnectionTransientError({
            reason: "transport",
            detail: `${input.label} did not answer a health check: ${error.message}`,
          }),
      ),
      Effect.asVoid,
      Effect.withSpan("RpcSession.probe"),
    );

    return {
      client,
      ready: Deferred.await(connected).pipe(Effect.raceFirst(Deferred.await(disconnected))),
      probe,
      closed: Deferred.await(disconnected),
    } satisfies RpcSession;
  });

  return RpcSessionFactory.of({ connect });
});

export const layer = Layer.effect(RpcSessionFactory, make);
