import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../../src/auth/ServerSecretStore.ts";
import * as SessionStore from "../../src/auth/SessionStore.ts";
import * as ServerConfig from "../../src/config.ts";

const layerStore = SessionStore.layer.pipe(Layer.provide(ServerSecretStore.layer));

// The config stays visible so a test can start a second store on the same state directory.
const layer = Layer.fresh(layerStore).pipe(
  Layer.provideMerge(ServerConfig.layerTest()),
  Layer.provideMerge(NodeServices.layer),
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

    it.effect("rejects a WebSocket ticket once its session expires", () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const issued = yield* sessions.issue({ method: "bearer-access-token" });

        // A minute before the 30-day session ends.
        yield* TestClock.adjust("43199 minutes");
        const { ticket } = yield* sessions.issueWebSocketTicket(issued);

        yield* sessions.verifyWebSocketTicket(ticket);
        // The session ends a minute later, well inside the ticket's five minutes.
        yield* TestClock.adjust("2 minutes");
        assert.strictEqual(yield* invalidReason(sessions.verifyWebSocketTicket(ticket)), "expired");
      }),
    );

    it.effect("keeps issued sessions valid after the server restarts", () =>
      Effect.gen(function* () {
        const issued = yield* (yield* SessionStore.SessionStore).issue({
          method: "browser-session-cookie",
        });

        const restarted = Context.get(
          yield* Layer.build(Layer.fresh(layerStore)),
          SessionStore.SessionStore,
        );

        const verified = yield* restarted.verify(issued.token);
        assert.strictEqual(verified.sessionId, issued.sessionId);
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
