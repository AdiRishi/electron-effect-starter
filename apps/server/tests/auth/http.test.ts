import {
  AuthAccessTokenType,
  AuthBootstrapTokenType,
  AuthTokenExchangeGrantType,
} from "@app/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Predicate from "effect/Predicate";
import * as References from "effect/References";
import { HttpClientRequest } from "effect/http";

import { makeTestServer } from "../support/testServer.ts";

interface LoggedEntry {
  readonly level: string;
  readonly message: unknown;
  readonly endpoint: unknown;
  readonly errorTag: unknown;
  readonly cause: unknown;
}

const captureLogs = (entries: Array<LoggedEntry>) =>
  Logger.layer([
    Logger.make((options) => {
      const message = Array.isArray(options.message) ? options.message : [options.message];
      const [text, fields] = message;
      const annotations = options.fiber.getRef(References.CurrentLogAnnotations);

      entries.push({
        level: options.logLevel,
        message: text,
        endpoint: annotations["http.endpoint"],
        errorTag: Predicate.hasProperty(fields, "errorTag") ? fields.errorTag : undefined,
        cause: Predicate.hasProperty(fields, "cause") ? fields.cause : undefined,
      });
    }),
  ]);

describe("auth HTTP routes", () => {
  // Real sockets need the live clock.
  it.layer(NodeServices.layer, { excludeTestServices: true })((it) => {
    it.effect("logs a rejected bootstrap credential as a failed request", () => {
      const logs: Array<LoggedEntry> = [];

      return Effect.gen(function* () {
        const { client } = yield* makeTestServer({ desktopBootstrapToken: "desktop-token" });

        const response = yield* client.execute(
          HttpClientRequest.post("/oauth/token").pipe(
            HttpClientRequest.bodyUrlParams({
              grant_type: AuthTokenExchangeGrantType,
              subject_token: "not-the-desktop-token",
              subject_token_type: AuthBootstrapTokenType,
              requested_token_type: AuthAccessTokenType,
            }),
          ),
        );

        assert.strictEqual(response.status, 401);
        assert.isTrue(
          logs.some(
            (entry) =>
              entry.level === "Warn" &&
              entry.message === "api request failed" &&
              entry.endpoint === "token" &&
              entry.errorTag === "AuthInvalidError",
          ),
        );
      }).pipe(Effect.provide(captureLogs(logs)));
    });

    it.effect("logs a warning for a rejected session credential", () => {
      const logs: Array<LoggedEntry> = [];

      return Effect.gen(function* () {
        const { client } = yield* makeTestServer();

        const response = yield* client.execute(
          HttpClientRequest.post("/api/auth/websocket-ticket").pipe(
            HttpClientRequest.bearerToken("forged.token"),
          ),
        );

        assert.strictEqual(response.status, 401);

        assert.isTrue(
          logs.some(
            (entry) =>
              entry.level === "Warn" &&
              entry.message === "Rejected authenticated session credential.",
          ),
        );
      }).pipe(Effect.provide(captureLogs(logs)));
    });

    it.effect("logs an internal failure with its cause before answering 500", () => {
      const logs: Array<LoggedEntry> = [];

      return Effect.gen(function* () {
        const { client, sql } = yield* makeTestServer({ desktopBootstrapToken: "desktop-token" });

        yield* sql`
          CREATE TRIGGER reject_auth_session_insert BEFORE INSERT ON auth_sessions
          BEGIN
            SELECT RAISE(ABORT, 'simulated insert failure');
          END
        `;

        const response = yield* client.execute(
          HttpClientRequest.post("/oauth/token").pipe(
            HttpClientRequest.bodyUrlParams({
              grant_type: AuthTokenExchangeGrantType,
              subject_token: "desktop-token",
              subject_token_type: AuthBootstrapTokenType,
              requested_token_type: AuthAccessTokenType,
            }),
          ),
        );

        assert.strictEqual(response.status, 500);

        const failure = logs.find(
          (entry) => entry.level === "Error" && entry.message === "api operation failed",
        );

        assert.include(String(failure?.cause), "ServerAuthAuthenticatedAccessTokenIssueError");
      }).pipe(Effect.provide(captureLogs(logs)));
    });
  });
});
