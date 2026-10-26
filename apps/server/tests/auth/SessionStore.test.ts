import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../../src/auth/ServerSecretStore.ts";
import * as SessionStore from "../../src/auth/SessionStore.ts";
import * as ServerConfig from "../../src/config.ts";

const layer = SessionStore.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerConfig.layerTest()),
  Layer.provide(NodeServices.layer),
);

const invalidReason = <A>(effect: Effect.Effect<A, SessionStore.SessionCredentialInvalidError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

describe("SessionStore", () => {
  it.layer(layer)((it) => {
    it.effect("verifies the sessions it issues", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const issued = yield* sessions.issue({ method: "bearer-access-token" });
        const verified = yield* sessions.verify(issued.token);
        assert.strictEqual(verified.sessionId, issued.sessionId);
        assert.strictEqual(verified.method, "bearer-access-token");
      }),
    );

    it.effect("rejects a token whose payload was altered", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const issued = yield* sessions.issue({ method: "bearer-access-token" });
        const [, signature] = issued.token.split(".");
        const forgedPayload = Buffer.from(
          JSON.stringify({
            v: 1,
            kind: "session",
            sid: "other",
            method: "bearer-access-token",
            iat: 0,
            exp: 9e15,
          }),
        ).toString("base64url");
        assert.strictEqual(
          yield* invalidReason(sessions.verify(`${forgedPayload}.${signature}`)),
          "bad_signature",
        );
      }),
    );

    it.effect("rejects a session after it expires", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const issued = yield* sessions.issue({ method: "browser-session-cookie" });
        yield* TestClock.adjust("31 days");
        assert.strictEqual(yield* invalidReason(sessions.verify(issued.token)), "expired");
      }),
    );

    it.effect("accepts a WebSocket ticket for five minutes and carries the session expiry", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const issued = yield* sessions.issue({ method: "bearer-access-token" });
        const { ticket } = yield* sessions.issueWebSocketTicket(issued);
        const fromTicket = yield* sessions.verifyWebSocketTicket(ticket);
        assert.strictEqual(fromTicket.sessionId, issued.sessionId);
        assert.strictEqual(
          fromTicket.expiresAt.epochMilliseconds,
          issued.expiresAt.epochMilliseconds,
        );
        yield* TestClock.adjust("6 minutes");
        assert.strictEqual(yield* invalidReason(sessions.verifyWebSocketTicket(ticket)), "expired");
      }),
    );

    it.effect("does not accept a session token as a WebSocket ticket", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const issued = yield* sessions.issue({ method: "bearer-access-token" });
        assert.strictEqual(
          yield* invalidReason(sessions.verifyWebSocketTicket(issued.token)),
          "bad_payload",
        );
      }),
    );
  });
});
