/**
 * Composition root.
 *
 * Wires the route layers over an HTTP server, provides the platform + services,
 * and drives the lifecycle: publish `starting`, mark HTTP listening once bound,
 * open the readiness gate, then publish `ready`.
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
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";

import * as Auth from "./auth.ts";
import * as ServerConfig from "./config.ts";
import {
  authBootstrapRouteLayer,
  corsLayer,
  healthRouteLayer,
  staticAndDevRouteLayer,
} from "./http.ts";
import * as LifecycleEvents from "./lifecycleEvents.ts";
import * as Readiness from "./readiness.ts";
import { clearRuntimeState, writeRuntimeState } from "./runtimeState.ts";
import { websocketRpcRouteLayer } from "./ws.ts";

/**
 * All HTTP routes. Order matters only for the `*` catch-all, which HttpRouter
 * dispatches after the exact-path routes. CORS wraps the whole router.
 */
export const routesLayer = Layer.mergeAll(
  healthRouteLayer,
  authBootstrapRouteLayer,
  websocketRpcRouteLayer,
  staticAndDevRouteLayer,
).pipe(Layer.provide(corsLayer));

/** Application services shared across routes and lifecycle. */
const RuntimeServicesLive = Layer.mergeAll(
  Auth.layer,
  LifecycleEvents.layer,
  Readiness.layer,
);

export const makeServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const runtimeStatePath = path.resolve(
      process.cwd(),
      ".app-server-runtime.json",
    );

    const httpServerLayer = NodeHttpServer.layer(NodeHttp.createServer, {
      host: config.host,
      port: config.port,
    });

    // Publish `starting` immediately as the runtime spins up.
    const startingLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        const lifecycle = yield* LifecycleEvents.ServerLifecycleEvents;
        const at = yield* Clock.currentTimeMillis;
        yield* lifecycle.publish({ phase: "starting", at });
      }),
    );

    // Once the HTTP server is bound: mark listening, persist runtime state,
    // open the readiness gate, and publish `ready`.
    const readyLayer = Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer;
          const readiness = yield* Readiness.ReadinessGate;
          const lifecycle = yield* LifecycleEvents.ServerLifecycleEvents;

          yield* readiness.markHttpListening;

          const address = server.address;
          const boundPort =
            typeof address === "string" || !("port" in address)
              ? config.port
              : address.port;

          yield* writeRuntimeState({
            path: runtimeStatePath,
            state: {
              port: boundPort,
              pid: process.pid,
              startedAt: config.startedAt,
            },
          }).pipe(Effect.ignore);

          yield* readiness.signalReady;
          const at = yield* Clock.currentTimeMillis;
          yield* lifecycle.publish({ phase: "ready", at });

          yield* Effect.logInfo("app server listening", {
            host: config.host,
            port: boundPort,
          });
        }),
        () => clearRuntimeState(runtimeStatePath).pipe(Effect.ignore),
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
      // Global-fetch HTTP client, not the undici-based Node one: the shell
      // spawns this server under Electron's bundled Node (v20.18), where
      // npm undici@8 crashes at load (`webidl.util.markAsUncloneable`). Global
      // fetch is self-consistent across Node 20/22/24 and Electron.
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(NodeServices.layer),
    );
  }),
);

// Important: only `ServerConfig` should be provided by the CLI layer. Keep other
// requirements out of the launch layer.
export const runServer = Layer.launch(makeServerLayer);
