// @effect-diagnostics nodeBuiltinImport:off -- NodeHttpServer takes a raw node:http server factory.
import * as NodeHttp from "node:http";

import { AppHttpApi } from "@app/contracts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as AuthHttp from "./auth/http.ts";
import * as BootstrapCredentials from "./auth/BootstrapCredentials.ts";
import * as ServerAuth from "./auth/ServerAuth.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import * as ServerConfig from "./config.ts";
import * as ServerHttp from "./http.ts";
import {
  guardHttpResponseWriteErrors,
  rejectRequestsUntilServing,
} from "./httpResponseErrorGuard.ts";
import * as Logger from "./logger.ts";
import * as NotesStore from "./notes/NotesStore.ts";
import * as Sqlite from "./persistence/Sqlite.ts";
import * as ServerLifecycleEvents from "./ServerLifecycleEvents.ts";
import { acquireServerOwnership } from "./serverOwnership.ts";
import * as Startup from "./startup.ts";
import * as Ws from "./ws.ts";

const layerHttpServer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;

    return NodeHttpServer.layer(
      () => rejectRequestsUntilServing(guardHttpResponseWriteErrors(NodeHttp.createServer())),
      {
        host: config.host,
        port: config.port,
        // Skip the default 20 s grace; WebSocket scope finalizers already close connections.
        gracefulShutdownTimeout: 0,
        websocket: { perMessageDeflate: true },
      },
    );
  }),
);

const layerAuth = ServerAuth.layer.pipe(
  Layer.provideMerge(SessionStore.layer),
  Layer.provideMerge(BootstrapCredentials.layer),
  Layer.provide(ServerSecretStore.layer),
);

export const layerServices = Layer.mergeAll(
  layerAuth,
  NotesStore.layer,
  ServerLifecycleEvents.layer,
).pipe(Layer.provideMerge(Sqlite.layerConfig));

export const layerRoutes = Layer.mergeAll(
  HttpApiBuilder.layer(AppHttpApi).pipe(
    Layer.provide(ServerHttp.layerMetadata),
    Layer.provide(AuthHttp.layer),
    Layer.provide(AuthHttp.layerAuthentication),
  ),
  Ws.layer,
  ServerHttp.layerStaticAndDevRoute,
).pipe(Layer.provide(ServerHttp.layerCors), Layer.provide(ServerHttp.layerHttpCompression));

const layerServer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    // Before anything opens the database: one server per state directory.
    yield* acquireServerOwnership(config.stateDir);

    return Startup.layer.pipe(
      Layer.provideMerge(
        HttpRouter.serve(layerRoutes, { disableLogger: !config.logWebSocketEvents }),
      ),
      Layer.provideMerge(layerServices),
      Layer.provideMerge(layerHttpServer),
    );
  }),
).pipe(Layer.provide(Logger.layer), Layer.provide(NodeServices.layer));

export const runServer = Layer.launch(layerServer);
