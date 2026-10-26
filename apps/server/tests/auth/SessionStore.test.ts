import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../../src/auth/ServerSecretStore.ts";
import * as SessionStore from "../../src/auth/SessionStore.ts";
import * as ServerConfig from "../../src/config.ts";
import * as Sqlite from "../../src/persistence/Sqlite.ts";

const layerStore = SessionStore.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(Sqlite.layerConfig),
);

// The config stays visible so a test can start a second store on the same state directory.
const layer = layerStore.pipe(
  Layer.provideMerge(ServerConfig.layerTest()),
  Layer.provideMerge(NodeServices.layer),
);

const failureTag = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error._tag),
  );

describe("SessionStore", () => {
  it.effect("verifies the sessions it issues", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({ method: "bearer-access-token", subject: "desktop" });
      const verified = yield* sessions.verify(issued.token);
      assert.strictEqual(verified.sessionId, issued.sessionId);
      assert.strictEqual(verified.method, "bearer-access-token");
      assert.strictEqual(verified.subject, "desktop");
    }).pipe(Effect.provide(layer)),
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
          sub: "browser",
          method: "bearer-access-token",
          iat: 0,
          exp: 9e15,
        }),
      ).toString("base64url");

      assert.strictEqual(
        yield* failureTag(sessions.verify(`${forgedPayload}.${signature}`)),
        "InvalidSessionTokenSignatureError",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects a token with more than a payload and a signature", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue();
      const ticket = yield* sessions.issueWebSocketToken(issued.sessionId);

      assert.strictEqual(
        yield* failureTag(sessions.verify(`${issued.token}.extra`)),
        "MalformedSessionTokenError",
      );
      assert.strictEqual(
        yield* failureTag(sessions.verifyWebSocketToken(`${ticket.token}.extra`)),
        "MalformedWebSocketTokenError",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects a session after it expires", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({ method: "browser-session-cookie" });
      yield* TestClock.adjust("31 days");
      assert.strictEqual(
        yield* failureTag(sessions.verify(issued.token)),
        "SessionTokenExpiredError",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("accepts a WebSocket ticket for five minutes and carries the session expiry", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({ method: "bearer-access-token" });
      const { token } = yield* sessions.issueWebSocketToken(issued.sessionId);
      const fromTicket = yield* sessions.verifyWebSocketToken(token);
      assert.strictEqual(fromTicket.sessionId, issued.sessionId);
      assert.strictEqual(
        fromTicket.expiresAt.epochMilliseconds,
        issued.expiresAt.epochMilliseconds,
      );
      yield* TestClock.adjust("6 minutes");
      assert.strictEqual(
        yield* failureTag(sessions.verifyWebSocketToken(token)),
        "WebSocketTokenExpiredError",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects websocket tokens once the parent session has expired", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({ method: "bearer-access-token" });

      // A minute before the 30-day session ends.
      yield* TestClock.adjust("43199 minutes");
      const websocket = yield* sessions.issueWebSocketToken(issued.sessionId);

      yield* sessions.verifyWebSocketToken(websocket.token);
      // The session ends a minute later, well inside the ticket's five minutes.
      yield* TestClock.adjust("2 minutes");

      const error = yield* Effect.flip(sessions.verifyWebSocketToken(websocket.token));
      assert.strictEqual(error._tag, "WebSocketSessionExpiredError");
      assert.strictEqual(
        "expiresAt" in error ? error.expiresAt.epochMilliseconds : undefined,
        issued.expiresAt.epochMilliseconds,
      );
    }).pipe(Effect.provide(layer)),
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
    }).pipe(Effect.provide(layer)),
  );

  it.effect("does not accept a session token as a WebSocket ticket", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({ method: "bearer-access-token" });
      assert.strictEqual(
        yield* failureTag(sessions.verifyWebSocketToken(issued.token)),
        "InvalidWebSocketTokenPayloadError",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect.each(["revoke", "revokeAllExcept", "replace"] as const)(
    "invalidates every connection for a session on %s and leaves other sessions active",
    (operation) =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const owner = yield* sessions.issue({ subject: "owner" });
        const client = yield* sessions.issue({ subject: "client", method: "bearer-access-token" });
        const ownerInvalidated = yield* Deferred.make<void>();

        yield* sessions
          .awaitInvalidation(owner.sessionId)
          .pipe(
            Effect.andThen(Deferred.succeed(ownerInvalidated, undefined)),
            Effect.forkScoped({ startImmediately: true }),
          );

        const first = yield* sessions
          .awaitInvalidation(client.sessionId)
          .pipe(Effect.forkScoped({ startImmediately: true }));

        const second = yield* sessions
          .awaitInvalidation(client.sessionId)
          .pipe(Effect.forkScoped({ startImmediately: true }));

        if (operation === "revoke") yield* sessions.revoke(client.sessionId);
        else if (operation === "revokeAllExcept") yield* sessions.revokeAllExcept(owner.sessionId);
        else
          yield* sessions.issue({
            subject: "client",
            method: "bearer-access-token",
            replaceSessionId: client.sessionId,
          });

        yield* Fiber.join(first);
        yield* Fiber.join(second);
        assert.isFalse(yield* Deferred.isDone(ownerInvalidated));
        yield* sessions.awaitInvalidation(client.sessionId);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("expires a session's connections at its credential deadline", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const client = yield* sessions.issue({ method: "bearer-access-token" });
      const invalidated = yield* Deferred.make<void>();

      const watcher = yield* sessions
        .awaitInvalidation(client.sessionId)
        .pipe(
          Effect.andThen(Deferred.succeed(invalidated, undefined)),
          Effect.forkScoped({ startImmediately: true }),
        );

      yield* TestClock.adjust(Duration.subtract(Duration.days(30), Duration.minutes(1)));
      assert.isFalse(yield* Deferred.isDone(invalidated));
      yield* TestClock.adjust(Duration.minutes(1));
      yield* Fiber.join(watcher);
      yield* sessions.awaitInvalidation(client.sessionId);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("atomically replaces active sessions with the same subject and method", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;

      const browser = yield* sessions.issue({
        subject: "desktop-bootstrap",
        method: "browser-session-cookie",
      });

      const [firstBearer, secondBearer] = yield* Effect.all(
        [
          sessions.issue({
            subject: "desktop-bootstrap",
            method: "bearer-access-token",
            replaceActiveForSubjectAndMethod: true,
          }),
          sessions.issue({
            subject: "desktop-bootstrap",
            method: "bearer-access-token",
            replaceActiveForSubjectAndMethod: true,
          }),
        ],
        { concurrency: "unbounded" },
      );

      const bearerVerification = yield* Effect.all([
        sessions.verify(firstBearer.token).pipe(Effect.option),
        sessions.verify(secondBearer.token).pipe(Effect.option),
      ]);

      assert.strictEqual((yield* sessions.verify(browser.token)).sessionId, browser.sessionId);
      assert.strictEqual(bearerVerification.filter(Option.isSome).length, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps the previous desktop session valid when replacement fails", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const sql = yield* SqlClient.SqlClient;

      const previous = yield* sessions.issue({
        subject: "desktop-bootstrap",
        method: "bearer-access-token",
      });

      yield* sql`
        CREATE TRIGGER reject_auth_session_insert BEFORE INSERT ON auth_sessions
        BEGIN
          SELECT RAISE(ABORT, 'simulated insert failure');
        END
      `;

      const error = yield* sessions
        .issue({
          subject: "desktop-bootstrap",
          method: "bearer-access-token",
          replaceActiveForSubjectAndMethod: true,
        })
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "SessionCredentialIssueError");
      assert.strictEqual((yield* sessions.verify(previous.token)).sessionId, previous.sessionId);
    }).pipe(Effect.provide(layer)),
  );

  it.effect.each(["insert", "revoke"] as const)(
    "keeps existing browser sessions valid when replacement cannot %s",
    (operation) =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const sql = yield* SqlClient.SqlClient;
        const previous = yield* sessions.issue({ subject: "one-time-token" });
        const unrelated = yield* sessions.issue({ subject: "one-time-token" });

        if (operation === "insert") {
          yield* sql`
            CREATE TRIGGER reject_auth_session_insert BEFORE INSERT ON auth_sessions
            BEGIN
              SELECT RAISE(ABORT, 'simulated insert failure');
            END
          `;
        } else {
          yield* sql`
            CREATE TRIGGER reject_auth_session_revocation BEFORE UPDATE OF revoked_at ON auth_sessions
            BEGIN
              SELECT RAISE(ABORT, 'simulated revocation failure');
            END
          `;
        }

        const error = yield* sessions
          .issue({ subject: "replacement-pairing", replaceSessionId: previous.sessionId })
          .pipe(Effect.flip);

        assert.strictEqual(error._tag, "SessionCredentialIssueError");
        assert.strictEqual((yield* sessions.verify(previous.token)).sessionId, previous.sessionId);
        assert.strictEqual(
          (yield* sessions.verify(unrelated.token)).sessionId,
          unrelated.sessionId,
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect("revokes every other session and rejects their tokens and tickets", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const administrative = yield* sessions.issue({ subject: "desktop-bootstrap" });
      const client = yield* sessions.issue({ subject: "one-time-token" });
      const clientWebSocket = yield* sessions.issueWebSocketToken(client.sessionId);

      const revokedCount = yield* sessions.revokeAllExcept(administrative.sessionId);
      const revokedClient = yield* Effect.flip(sessions.verify(client.token));

      const revokedClientWebSocket = yield* Effect.flip(
        sessions.verifyWebSocketToken(clientWebSocket.token),
      );

      assert.strictEqual(revokedCount, 1);

      assert.strictEqual(
        (yield* sessions.verify(administrative.token)).sessionId,
        administrative.sessionId,
      );

      assert.strictEqual(revokedClient._tag, "SessionTokenRevokedError");
      assert.strictEqual(revokedClientWebSocket._tag, "WebSocketSessionRevokedError");
      assert.isFalse(yield* sessions.revoke(client.sessionId));
    }).pipe(Effect.provide(layer)),
  );
});
