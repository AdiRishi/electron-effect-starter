import { WS_PATH, WS_TICKET_QUERY_PARAM, WsRpcGroup } from "@app/contracts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import { HttpClient, HttpRouter, HttpServer } from "effect/http";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schedule from "effect/Schedule";
import * as Socket from "effect/socket/Socket";

import * as ServerConfig from "../../src/config.ts";
import * as Server from "../../src/server.ts";

/** The real routes and services on a random loopback port, with a scratch state directory. */
export const makeTestServer = Effect.fn("TestServer.make")(function* (options?: {
  readonly desktopBootstrapToken?: string;
  readonly staticDir?: string;
}) {
  const context = yield* Layer.build(
    HttpRouter.serve(Server.layerRoutes, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.provideMerge(Server.layerServices),
      Layer.provideMerge(ServerConfig.layerTest(options)),
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provideMerge(NodeServices.layer),
    ),
  );
  const address = Context.get(context, HttpServer.HttpServer).address;
  if (Predicate.isTagged(address, "UnixPathAddress"))
    return yield* Effect.die("Test server bound a unix socket.");
  return {
    client: Context.get(context, HttpClient.HttpClient),
    // The test server listens on the wildcard address, which a client cannot dial.
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
});

/** A typed WS RPC client authenticated with a WebSocket ticket, open for the caller's scope. */
export const connectRpc = Effect.fn("TestServer.connectRpc")(function* (
  baseUrl: string,
  ticket: string | undefined,
) {
  const url = new URL(WS_PATH, baseUrl.replace(/^http/, "ws"));
  if (ticket !== undefined) url.searchParams.set(WS_TICKET_QUERY_PARAM, ticket);
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolSocket({ retryPolicy: Schedule.recurs(0) }).pipe(
      Layer.provide(Socket.layerWebSocket(url.toString())),
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
      Layer.provide(RpcSerialization.layerJson),
    ),
  );
  return yield* RpcClient.make(WsRpcGroup).pipe(Effect.provideContext(protocol));
});
