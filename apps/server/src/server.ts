/**
 * Composition root.
 *
 * Wires the route layers over an HTTP server, provides the platform + services,
 * and drives the lifecycle: publish `starting`, open the readiness gate and
 * publish `ready` once the HTTP server is bound, publish `draining` on shutdown.
 *
 * Only `ServerConfig` is provided by the CLI — nothing else leaks into the
 * launch layer.
 *
 * @module server
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";

import * as Auth from "./auth.ts";
import * as ServerConfig from "./config.ts";
import {
  authBootstrapRouteLayer,
  authWsTicketRouteLayer,
  corsLayer,
  healthRouteLayer,
  staticAndDevRouteLayer,
} from "./http.ts";
import * as LifecycleEvents from "./lifecycleEvents.ts";
import * as NotesStore from "./notes/NotesStore.ts";
import * as Readiness from "./readiness.ts";
import { websocketRpcRouteLayer } from "./ws.ts";

/**
 * All HTTP routes. Order matters only for the `*` catch-all, which HttpRouter
 * dispatches after the exact-path routes. CORS wraps the whole router.
 */
export const routesLayer = Layer.mergeAll(
  healthRouteLayer,
  authBootstrapRouteLayer,
  authWsTicketRouteLayer,
  websocketRpcRouteLayer,
  staticAndDevRouteLayer,
).pipe(Layer.provide(corsLayer));

/** Application services shared across routes and lifecycle. */
const RuntimeServicesLive = Layer.mergeAll(
  Auth.layer,
  LifecycleEvents.layer,
  NotesStore.layer,
  Readiness.layer,
);

export const makeServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;

    const httpServerLayer = NodeHttpServer.layer(NodeHttp.createServer, {
      host: config.host,
      port: config.port,
      // No preemptive drain window (the default is 20s): the long-lived `/ws`
      // connections keep request scopes open, so the default timer would hold
      // the process alive on SIGTERM waiting for sockets the WS finalizers
      // already close gracefully.
      gracefulShutdownTimeout: 0,
    });

    // Publish `starting` immediately as the runtime spins up.
    const startingLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        const lifecycle = yield* LifecycleEvents.ServerLifecycleEvents;
        const at = yield* DateTime.now;
        yield* lifecycle.publish({ phase: "starting", at });
      }),
    );

    // Once the HTTP server is bound: open the readiness gate and publish
    // `ready`. On shutdown the release runs first (before the HTTP server
    // closes), so `draining` reaches live subscribers ahead of the socket drop.
    const readyLayer = Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer;
          const readiness = yield* Readiness.ReadinessGate;
          const lifecycle = yield* LifecycleEvents.ServerLifecycleEvents;

          const address = server.address;
          const boundPort =
            typeof address === "string" || !("port" in address) ? config.port : address.port;

          yield* readiness.signalReady;
          const at = yield* DateTime.now;
          yield* lifecycle.publish({ phase: "ready", at });

          yield* Effect.logInfo("app server listening", {
            host: config.host,
            port: boundPort,
          });
          return lifecycle;
        }),
        (lifecycle) =>
          Effect.gen(function* () {
            const at = yield* DateTime.now;
            yield* lifecycle.publish({ phase: "draining", at });
            yield* Effect.logInfo("app server draining");
          }),
      ),
    );

    const applicationLayer = Layer.mergeAll(
      HttpRouter.serve(routesLayer),
      startingLayer,
      readyLayer,
    );

    return applicationLayer.pipe(
      Layer.provideMerge(RuntimeServicesLive),
      Layer.provideMerge(httpServerLayer),
      // The stack's only HttpClient (NodeServices does not bundle one).
      // Nothing consumes it yet; it is pre-wired for handlers that make
      // outbound requests. Global fetch, not the undici-based Node client:
      // the shell spawns this server under Electron's bundled Node (v20.18),
      // where npm undici@8 crashes at load (`webidl.util.markAsUncloneable`).
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(NodeServices.layer),
    );
  }),
);

// Important: only `ServerConfig` should be provided by the CLI layer. Keep other
// requirements out of the launch layer.
export const runServer = Layer.launch(makeServerLayer);
