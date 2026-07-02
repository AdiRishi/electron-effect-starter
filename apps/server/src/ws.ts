/**
 * WebSocket RPC route + handler registration.
 *
 * `/ws` upgrades to the Effect RPC websocket protocol after a bearer-auth gate.
 * The four `WsRpcGroup` methods are registered via `WsRpcGroup.toLayer`:
 *  - `server.getConfig` (unary)
 *  - `echo` (unary)
 *  - `subscribeTicks` (stream)
 *  - `subscribeServerLifecycle` (stream, ordered push bus)
 *
 * @module ws
 */
import {
  EnvironmentAuthorizationError,
  WS_METHODS,
  WsRpcGroup,
  type ServerLifecycleStreamEvent,
  type TickEvent,
} from "@app/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import * as Auth from "./auth.ts";
import * as ServerConfig from "./config.ts";
import * as LifecycleEvents from "./lifecycleEvents.ts";

/**
 * Extract a bearer token from the upgrade request: `Authorization: Bearer <t>`
 * header, or `?access_token=<t>` query param (browsers can't set WS headers).
 */
function extractBearer(request: HttpServerRequest.HttpServerRequest): Option.Option<string> {
  const header = Headers.get(request.headers, "authorization");
  if (Option.isSome(header)) {
    const match = /^Bearer\s+(.+)$/i.exec(header.value.trim());
    if (match?.[1]) {
      return Option.some(match[1].trim());
    }
  }
  const url = HttpServerRequest.toURL(request);
  if (Option.isSome(url)) {
    const token = url.value.searchParams.get("access_token");
    if (token) {
      return Option.some(token);
    }
  }
  return Option.none();
}

/**
 * Register the four RPC handlers. `subscribeServerLifecycle` replays the retained
 * snapshot (sorted by sequence) then follows the live stream filtered to events
 * newer than the snapshot boundary.
 */
const makeWsRpcLayer = () =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const lifecycleEvents = yield* LifecycleEvents.ServerLifecycleEvents;

      return WsRpcGroup.of({
        [WS_METHODS.serverGetConfig]: () =>
          Effect.succeed({
            appName: config.appName,
            version: config.version,
            startedAt: config.startedAt,
          }),
        [WS_METHODS.echo]: (input) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((receivedAt) => ({
              message: input.message,
              receivedAt,
            })),
          ),
        [WS_METHODS.subscribeTicks]: () =>
          Stream.tick("1 second").pipe(
            Stream.mapAccum(
              () => 0,
              (count, _void) => {
                const next = count + 1;
                return [next, [next]] as const;
              },
            ),
            Stream.mapEffect((tick) =>
              Clock.currentTimeMillis.pipe(Effect.map((at): TickEvent => ({ tick, at }))),
            ),
          ),
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.unwrap(
            Effect.gen(function* () {
              const snapshot = yield* lifecycleEvents.snapshot;
              const replay = [...snapshot.events].sort((a, b) => a.sequence - b.sequence);
              const live = lifecycleEvents.stream.pipe(
                Stream.filter(
                  (event: ServerLifecycleStreamEvent) => event.sequence > snapshot.sequence,
                ),
              );
              return Stream.concat(Stream.fromIterable(replay), live);
            }),
          ),
      });
    }),
  );

/**
 * The `/ws` upgrade route. Rejects with 401 when no valid bearer is present,
 * otherwise hands the socket to the RPC server.
 */
export const websocketRpcRouteLayer = HttpRouter.add(
  "GET",
  "/ws",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* Auth.BearerSessionStore;

    const token = extractBearer(request);
    if (Option.isNone(token)) {
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }
    const valid = yield* auth.authenticateBearer(token.value);
    if (!valid) {
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }

    const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, {
      disableTracing: true,
    }).pipe(Effect.provide(makeWsRpcLayer().pipe(Layer.provideMerge(RpcSerialization.layerJson))));

    return yield* rpcWebSocketHttpEffect;
  }),
);
