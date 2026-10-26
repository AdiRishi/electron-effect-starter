import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/http";

import * as ServerAuth from "./auth/ServerAuth.ts";
import * as ServerConfig from "./config.ts";
import { serverDescriptor } from "./descriptor.ts";
import * as ServerLifecycleEvents from "./ServerLifecycleEvents.ts";

/** Announces the server once it is listening, and prints a browser pairing URL in web mode. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const server = yield* HttpServer.HttpServer;
    const lifecycle = yield* ServerLifecycleEvents.ServerLifecycleEvents;
    const auth = yield* ServerAuth.ServerAuth;
    const descriptor = yield* serverDescriptor;

    yield* lifecycle.publish({ version: 1, type: "welcome", payload: { server: descriptor } });

    const listeningUrl = HttpServer.formatAddress(server.address);
    yield* Effect.logInfo("Server ready", { mode: config.mode, stateDir: config.stateDir });

    if (config.mode === "web") {
      const pairingUrl = yield* auth.issueStartupPairingUrl(
        config.devUrl?.toString() ?? listeningUrl,
      );
      yield* Effect.logInfo(`Open ${pairingUrl} to sign this browser in.`);
    }

    yield* lifecycle.publish({
      version: 1,
      type: "ready",
      payload: { at: yield* DateTime.now, server: descriptor },
    });
  }),
);
