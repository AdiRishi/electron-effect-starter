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
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
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
 * The query parameter carrying the short-lived WS ticket. Browsers can't set
 * headers on a WebSocket upgrade, so a credential must ride in the URL — but
 * ONLY the 5-minute ticket is accepted there, never the long-lived bearer
 * (URLs leak into proxy logs, browser history, and `Referer` headers). A
 * non-browser client that can set headers may still present the bearer via
 * `Authorization`.
 */
const WS_TICKET_QUERY_PARAM = "wsTicket";

function extractWsTicket(request: HttpServerRequest.HttpServerRequest): Option.Option<string> {
  const url = HttpServerRequest.toURL(request);
  if (Option.isSome(url)) {
    const ticket = url.value.searchParams.get(WS_TICKET_QUERY_PARAM);
    if (ticket && ticket.trim().length > 0) {
      return Option.some(ticket);
    }
  }
  return Option.none();
}

/** Authorize the upgrade: a `wsTicket` query param, or a header bearer. */
function authorizeUpgrade(
  auth: Auth.BearerSessionStore["Service"],
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<boolean> {
  const ticket = extractWsTicket(request);
  if (Option.isSome(ticket)) {
    return auth.authenticateWsTicket(ticket.value);
  }
  const bearer = Auth.extractAuthorizationBearer(request);
  if (Option.isSome(bearer)) {
    return auth.authenticateBearer(bearer.value);
  }
  return Effect.succeed(false);
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

    if (!(yield* authorizeUpgrade(auth, request))) {
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }

    const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, {
      disableTracing: true,
    }).pipe(Effect.provide(makeWsRpcLayer().pipe(Layer.provideMerge(RpcSerialization.layerJson))));

    return yield* rpcWebSocketHttpEffect;
  }),
);
