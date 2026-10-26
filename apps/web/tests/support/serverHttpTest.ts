import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  AppHttpApi,
  AuthenticatedPrincipal,
  type AuthBrowserSessionRequest,
  type AuthBrowserSessionResult,
  type AuthInvalidError,
  AuthSessionId,
  type AuthSessionState,
  HttpAuthentication,
} from "@app/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiTest from "effect/http-api/HttpApiTest";

import { __setServerHttpRunnerForTests, type ServerHttpRunner } from "~/server/http";

interface ServerHttpTestScenario {
  readonly session?: () => Effect.Effect<AuthSessionState>;
  readonly browserSession?: (
    payload: AuthBrowserSessionRequest,
  ) => Effect.Effect<AuthBrowserSessionResult, AuthInvalidError>;
  /** Wraps the runner, to fail requests before they reach the server. */
  readonly transport?: (runner: ServerHttpRunner) => ServerHttpRunner;
}

export interface ServerHttpTestCalls {
  session: number;
  browserSession: Array<AuthBrowserSessionRequest>;
}

const unexpectedEndpoint = (endpoint: string) =>
  Effect.die(new Error(`Unexpected server HTTP endpoint: ${endpoint}`));

const layerTestAuthentication = Layer.succeed(HttpAuthentication, (httpEffect) =>
  httpEffect.pipe(
    Effect.provideService(AuthenticatedPrincipal, {
      sessionId: AuthSessionId.make("test-session"),
      method: "browser-session-cookie",
      expiresAt: DateTime.makeUnsafe("2026-05-01T12:00:00.000Z"),
    }),
  ),
);

/**
 * Serves the auth API in memory, through the real request and response encoding, and points
 * runServerHttp at it until `dispose`.
 */
export async function installServerHttpTest(scenario: ServerHttpTestScenario) {
  const calls: ServerHttpTestCalls = { session: 0, browserSession: [] };

  const client = await Effect.runPromise(
    HttpApiTest.groups(AppHttpApi, ["auth"]).pipe(
      Effect.provide([
        NodeHttpServer.layerHttpServices,
        HttpApiBuilder.group(AppHttpApi, "auth", (handlers) =>
          handlers
            .handle(
              "session",
              Effect.fn("test.server.auth.session")(function* () {
                calls.session += 1;

                return yield* scenario.session?.() ?? unexpectedEndpoint("auth.session");
              }),
            )
            .handle(
              "browserSession",
              Effect.fn("test.server.auth.browserSession")(function* ({ payload }) {
                calls.browserSession.push(payload);

                return yield* (
                  scenario.browserSession?.(payload) ?? unexpectedEndpoint("auth.browserSession")
                );
              }),
            )
            .handle("token", () => unexpectedEndpoint("auth.token"))
            .handle("webSocketTicket", () => unexpectedEndpoint("auth.webSocketTicket")),
        ),
      ]),
      Effect.provide(layerTestAuthentication),
      Effect.scoped,
    ),
  );

  const runner: ServerHttpRunner = (request) => Effect.runPromise(request(client));
  __setServerHttpRunnerForTests(scenario.transport?.(runner) ?? runner);

  return {
    calls,
    dispose() {
      __setServerHttpRunnerForTests();
    },
  };
}
