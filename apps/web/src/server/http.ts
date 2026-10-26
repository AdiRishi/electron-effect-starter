import { AppHttpApi } from "@app/contracts";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import { currentServerTarget } from "./current";

export type ServerHttpClient = HttpApiClient.ForApi<typeof AppHttpApi>;

export type ServerHttpRunner = <A, E>(
  request: (client: ServerHttpClient) => Effect.Effect<A, E>,
) => Promise<A>;

const liveServerHttpRunner: ServerHttpRunner = (request) =>
  Effect.runPromise(
    HttpApiClient.make(AppHttpApi, { baseUrl: currentServerTarget().httpBaseUrl }).pipe(
      Effect.flatMap(request),
      Effect.provide(FetchHttpClient.layer),
    ),
  );

let serverHttpRunner = liveServerHttpRunner;

/** Runs one request against the server's HTTP API; a typed failure rejects with the error itself. */
export const runServerHttp: ServerHttpRunner = (request) => serverHttpRunner(request);

export function __setServerHttpRunnerForTests(runner?: ServerHttpRunner): void {
  serverHttpRunner = runner ?? liveServerHttpRunner;
}
