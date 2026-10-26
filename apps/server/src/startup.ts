import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/http";

import * as ServerAuth from "./auth/ServerAuth.ts";
import * as ServerConfig from "./config.ts";
import { serverDescriptor } from "./descriptor.ts";
import * as ServerLifecycleEvents from "./ServerLifecycleEvents.ts";

export const isWildcardHost = (host: string | undefined): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

export const formatHostForUrl = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

/** Where a browser should open this server: the dev server, the bound host, or localhost for a wildcard bind. */
export const resolveStartupBrowserTarget = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const localUrl = `http://localhost:${serverConfig.port}`;

  const bindUrl =
    serverConfig.host && !isWildcardHost(serverConfig.host)
      ? `http://${formatHostForUrl(serverConfig.host)}:${serverConfig.port}`
      : localUrl;

  return serverConfig.devUrl?.toString() ?? bindUrl;
});

/** Prints the one-time pairing URL to stdout only; logger records reach span events and collectors. */
export const announceStartupPairingUrl = (pairingUrl: string) =>
  Effect.logInfo("Authentication required. Open the app using the pairing URL.").pipe(
    Effect.andThen(Console.log(`  pairingUrl: ${pairingUrl}`)),
  );

/** Announces the server once it is listening, and prints a browser pairing URL in web mode. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    // Requiring the server keeps this layer after the listener, so the pairing URL works when printed.
    yield* HttpServer.HttpServer;
    const config = yield* ServerConfig.ServerConfig;
    const lifecycle = yield* ServerLifecycleEvents.ServerLifecycleEvents;
    const auth = yield* ServerAuth.ServerAuth;
    const descriptor = yield* serverDescriptor;

    yield* lifecycle.publish({ version: 1, type: "welcome", payload: { server: descriptor } });
    yield* Effect.logInfo("Server ready", { mode: config.mode, stateDir: config.stateDir });

    if (config.mode === "web") {
      const pairingUrl = yield* auth.issueStartupPairingUrl(yield* resolveStartupBrowserTarget);
      yield* announceStartupPairingUrl(pairingUrl);
    }

    yield* lifecycle.publish({
      version: 1,
      type: "ready",
      payload: { at: yield* DateTime.now, server: descriptor },
    });
  }),
);
