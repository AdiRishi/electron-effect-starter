/**
 * WebSocket RPC route + handler registration.
 *
 * `/ws` upgrades to the Effect RPC websocket protocol after a bearer-auth gate.
 * The `WsRpcGroup` methods are registered via `WsRpcGroup.toLayer`:
 *  - `server.getConfig` / `server.echo` (unary transport templates)
 *  - `server.subscribeTicks` (stream template)
 *  - `server.subscribeLifecycle` (stream, ordered push bus)
 *  - `notes.*` (the sample domain: unary mutations + a push-bus subscription)
 *
 * @module ws
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import {
  WS_METHODS,
  WsRpcGroup,
  type ServerLifecycleStreamEvent,
  type TickEvent,
} from "@app/contracts";

import * as Auth from "./auth.ts";
import * as ServerConfig from "./config.ts";
import * as LifecycleEvents from "./lifecycleEvents.ts";
import * as NotesStore from "./notes/NotesStore.ts";

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
 * Register the RPC handlers. `server.subscribeLifecycle` replays the retained
 * snapshot (sorted by sequence) then follows the live stream filtered to events
 * newer than the snapshot boundary; `notes.subscribe` delegates the same
 * contract to the notes store.
 */
const makeWsRpcLayer = () =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const lifecycleEvents = yield* LifecycleEvents.ServerLifecycleEvents;
      const notes = yield* NotesStore.NotesStore;

      return WsRpcGroup.of({
        [WS_METHODS.serverGetConfig]: () =>
          Effect.succeed({
            appName: config.appName,
            version: config.version,
            startedAt: config.startedAt,
          }),
        [WS_METHODS.serverEcho]: (input) =>
          DateTime.now.pipe(
            Effect.map((receivedAt) => ({
              message: input.message,
              receivedAt,
            })),
          ),
        [WS_METHODS.serverSubscribeTicks]: () =>
          Stream.tick("1 second").pipe(
            Stream.mapAccum(
              () => 0,
              (count, _void) => {
                const next = count + 1;
                return [next, [next]] as const;
              },
            ),
            Stream.mapEffect((tick) =>
              DateTime.now.pipe(Effect.map((at): TickEvent => ({ tick, at }))),
            ),
          ),
        [WS_METHODS.serverSubscribeLifecycle]: () =>
          Stream.unwrap(
            Effect.gen(function* () {
              const snapshot = yield* lifecycleEvents.snapshot;
              const replay = snapshot.events.toSorted((a, b) => a.sequence - b.sequence);
              const live = lifecycleEvents.stream.pipe(
                Stream.filter(
                  (event: ServerLifecycleStreamEvent) => event.sequence > snapshot.sequence,
                ),
              );
              return Stream.concat(Stream.fromIterable(replay), live);
            }),
          ),
        [WS_METHODS.notesCreate]: (input) => notes.create(input),
        [WS_METHODS.notesUpdate]: (input) => notes.update(input),
        [WS_METHODS.notesDelete]: (input) => notes.remove(input),
        [WS_METHODS.notesSubscribe]: () => notes.changes,
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
