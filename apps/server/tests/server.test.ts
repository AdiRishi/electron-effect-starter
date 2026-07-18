import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpBody, HttpClient, HttpRouter, HttpServer } from "effect/unstable/http";

import { BearerSessionJson, WsTicketJson } from "@app/contracts";

import * as Auth from "../src/auth.ts";
import * as ServerConfig from "../src/config.ts";
import { AUTH_BOOTSTRAP_PATH, AUTH_WS_TICKET_PATH, HEALTH_PATH } from "../src/http.ts";
import * as LifecycleEvents from "../src/lifecycleEvents.ts";
import * as NotesStore from "../src/notes/NotesStore.ts";
import * as Readiness from "../src/readiness.ts";
import { routesLayer } from "../src/server.ts";

const BOOTSTRAP_TOKEN = "boot-secret";

// Static fixtures live in a module-scope temp dir so the config layer can
// reference them before any Effect runs. `secret.txt` sits OUTSIDE the static
// root: no request may ever surface its contents.
const SCRATCH = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "app-server-test-"));
const STATIC_ROOT = NodePath.join(SCRATCH, "root");
NodeFS.mkdirSync(NodePath.join(STATIC_ROOT, "assets"), { recursive: true });
NodeFS.writeFileSync(NodePath.join(STATIC_ROOT, "index.html"), "<html>INDEX_SENTINEL</html>");
NodeFS.writeFileSync(NodePath.join(STATIC_ROOT, "assets", "app.js"), "APP_JS_SENTINEL");
NodeFS.writeFileSync(NodePath.join(SCRATCH, "secret.txt"), "TOP_SECRET");

interface HarnessOptions {
  readonly staticDir?: string;
  readonly devWebUrl?: URL;
}

/** The real route stack + services over the platform test server. */
const appLayer = (options: HarnessOptions = {}) =>
  HttpRouter.serve(routesLayer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(Auth.layer, LifecycleEvents.layer, NotesStore.layer, Readiness.layer),
    ),
    Layer.provideMerge(
      Layer.unwrap(
        Effect.gen(function* () {
          const startedAt = yield* DateTime.now;
          return ServerConfig.layer(
            ServerConfig.make({
              appName: "Test App",
              version: "0.0.0-test",
              startedAt,
              host: "127.0.0.1",
              port: 0,
              staticDir: options.staticDir,
              devWebUrl: options.devWebUrl,
              bootstrapToken: BOOTSTRAP_TOKEN,
              dataDir: NodePath.join(SCRATCH, "data"),
            }),
          );
        }),
      ),
    ),
    // NodeServices provides Crypto in production; layerTest does not.
    Layer.provideMerge(Layer.mergeAll(NodeHttpServer.layerTest, NodeCrypto.layer)),
  );

const decodeBearerSession = Schema.decodeUnknownSync(BearerSessionJson);
const decodeWsTicket = Schema.decodeUnknownSync(WsTicketJson);

const postJson = (path: string, body: string) =>
  HttpClient.post(path, { body: HttpBody.text(body, "application/json") });

/**
 * Issue a request with the path passed through verbatim — no WHATWG URL
 * normalization. Traversal probes like `/../secret.txt` must reach the server
 * as written, which `fetch` would silently rewrite.
 */
const rawGet = (rawPath: string) =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address;
    const port = typeof address === "string" || !("port" in address) ? 0 : address.port;

    return yield* Effect.callback<{
      readonly status: number;
      readonly location: string | undefined;
      readonly body: string;
    }>((resume) => {
      const request = NodeHttp.request(
        { host: "127.0.0.1", port, path: rawPath, method: "GET" },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.on("end", () => {
            resume(
              Effect.succeed({
                status: response.statusCode ?? 0,
                location: response.headers.location,
                body,
              }),
            );
          });
        },
      );
      request.once("error", (cause) => {
        resume(Effect.die(cause));
      });
      request.end();
      return Effect.sync(() => {
        request.destroy();
      });
    });
  });

describe("health gate", () => {
  it.effect("reports 503 until the readiness gate opens, then 200", () =>
    Effect.gen(function* () {
      const before = yield* HttpClient.get(HEALTH_PATH);
      assert.equal(before.status, 503);

      const gate = yield* Readiness.ReadinessGate;
      yield* gate.signalReady;

      const after = yield* HttpClient.get(HEALTH_PATH);
      assert.equal(after.status, 200);
      assert.equal(yield* after.text, "ok");
    }).pipe(Effect.provide(appLayer())),
  );
});

describe("bearer bootstrap exchange", () => {
  it.effect("exchanges the bootstrap token for a bearer session in the JSON wire shape", () =>
    Effect.gen(function* () {
      const response = yield* postJson(
        AUTH_BOOTSTRAP_PATH,
        JSON.stringify({ credential: BOOTSTRAP_TOKEN }),
      );
      assert.equal(response.status, 200);

      const body: unknown = yield* response.json;
      // Exact wire shape: the codec decodes it, and nothing extra rides along.
      const session = decodeBearerSession(body);
      assert.match(session.access_token, /^[0-9a-f]{64}$/);
      assert.isNull(session.expires_at);
      assert.deepEqual(Object.keys(body as object).toSorted(), ["access_token", "expires_at"]);

      // The minted bearer is immediately valid for the WS gate.
      const auth = yield* Auth.BearerSessionStore;
      assert.isTrue(yield* auth.authenticateBearer(session.access_token));
    }).pipe(Effect.provide(appLayer())),
  );

  it.effect("rejects a wrong credential with 401", () =>
    Effect.gen(function* () {
      const response = yield* postJson(
        AUTH_BOOTSTRAP_PATH,
        JSON.stringify({ credential: "wrong" }),
      );
      assert.equal(response.status, 401);
    }).pipe(Effect.provide(appLayer())),
  );

  it.effect("rejects malformed bodies with 400", () =>
    Effect.gen(function* () {
      const empty = yield* postJson(AUTH_BOOTSTRAP_PATH, JSON.stringify({ credential: "  " }));
      assert.equal(empty.status, 400);

      const notJson = yield* postJson(AUTH_BOOTSTRAP_PATH, "not json");
      assert.equal(notJson.status, 400);
    }).pipe(Effect.provide(appLayer())),
  );
});

describe("websocket ticket exchange", () => {
  const mintBearer = Effect.gen(function* () {
    const response = yield* postJson(
      AUTH_BOOTSTRAP_PATH,
      JSON.stringify({ credential: BOOTSTRAP_TOKEN }),
    );
    const body: unknown = yield* response.json;
    return decodeBearerSession(body).access_token;
  });

  it.effect("exchanges a live bearer for a short-lived ticket in the JSON wire shape", () =>
    Effect.gen(function* () {
      const bearer = yield* mintBearer;
      const response = yield* HttpClient.post(AUTH_WS_TICKET_PATH, {
        headers: { authorization: `Bearer ${bearer}` },
      });
      assert.equal(response.status, 200);

      const body: unknown = yield* response.json;
      const issued = decodeWsTicket(body);
      assert.match(issued.ticket, /^[0-9a-f]{64}$/);
      assert.deepEqual(Object.keys(body as object).toSorted(), ["expires_at", "ticket"]);

      // The minted ticket is immediately valid for the WS gate; the ticket is
      // its own credential, distinct from the bearer.
      const auth = yield* Auth.BearerSessionStore;
      assert.isTrue(yield* auth.authenticateWsTicket(issued.ticket));
      assert.isFalse(yield* auth.authenticateWsTicket(bearer));
    }).pipe(Effect.provide(appLayer())),
  );

  it.effect("rejects ticket minting without a live bearer", () =>
    Effect.gen(function* () {
      const missing = yield* HttpClient.post(AUTH_WS_TICKET_PATH);
      assert.equal(missing.status, 401);

      const invalid = yield* HttpClient.post(AUTH_WS_TICKET_PATH, {
        headers: { authorization: "Bearer not-a-live-session" },
      });
      assert.equal(invalid.status, 401);
    }).pipe(Effect.provide(appLayer())),
  );

  it.effect("expires tickets after their TTL", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.BearerSessionStore;
      const bearer = yield* mintBearer;
      const issued = yield* auth.issueWsTicket(bearer);
      assert.isTrue(Option.isSome(issued));
      if (Option.isSome(issued)) {
        assert.isTrue(yield* auth.authenticateWsTicket(issued.value.ticket));
        yield* TestClock.adjust("6 minutes");
        assert.isFalse(yield* auth.authenticateWsTicket(issued.value.ticket));
        // The bearer itself is process-lifetime and still valid.
        assert.isTrue(yield* auth.authenticateBearer(bearer));
      }
    }).pipe(Effect.provide(appLayer())),
  );
});

describe("websocket gate", () => {
  it.effect("rejects /ws without a credential", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/ws");
      assert.equal(response.status, 401);
    }).pipe(Effect.provide(appLayer())),
  );

  it.effect("rejects the long-lived bearer on the query string — tickets only", () =>
    Effect.gen(function* () {
      const bootstrap = yield* postJson(
        AUTH_BOOTSTRAP_PATH,
        JSON.stringify({ credential: BOOTSTRAP_TOKEN }),
      );
      const bearer = decodeBearerSession(yield* bootstrap.json).access_token;

      // The old-style `?access_token=` carries no weight at all…
      const viaAccessToken = yield* HttpClient.get(`/ws?access_token=${bearer}`);
      assert.equal(viaAccessToken.status, 401);
      // …and a bearer pasted into the ticket param is not a ticket.
      const viaTicketParam = yield* HttpClient.get(`/ws?wsTicket=${bearer}`);
      assert.equal(viaTicketParam.status, 401);
    }).pipe(Effect.provide(appLayer())),
  );
});

describe("static serving", () => {
  it.effect("serves index.html at the root and real assets by path", () =>
    Effect.gen(function* () {
      const index = yield* HttpClient.get("/");
      assert.equal(index.status, 200);
      assert.include(yield* index.text, "INDEX_SENTINEL");

      const asset = yield* HttpClient.get("/assets/app.js");
      assert.equal(asset.status, 200);
      assert.include(yield* asset.text, "APP_JS_SENTINEL");
    }).pipe(Effect.provide(appLayer({ staticDir: STATIC_ROOT }))),
  );

  it.effect("falls back to index.html for unknown SPA routes", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/settings/updates");
      assert.equal(response.status, 200);
      assert.include(yield* response.text, "INDEX_SENTINEL");
    }).pipe(Effect.provide(appLayer({ staticDir: STATIC_ROOT }))),
  );

  it.effect("never serves files outside the static root", () =>
    Effect.gen(function* () {
      // Raw paths bypass fetch's URL normalization, so `..` reaches the server.
      const probes = [
        "/../secret.txt",
        "/%2e%2e/secret.txt",
        "/..%2fsecret.txt",
        "/assets/../../secret.txt",
        "/..%5csecret.txt",
        "/assets/%00/../../secret.txt",
      ];
      for (const probe of probes) {
        const response = yield* rawGet(probe);
        assert.notInclude(response.body, "TOP_SECRET", `path ${probe} must not leak`);
      }
    }).pipe(Effect.provide(appLayer({ staticDir: STATIC_ROOT }))),
  );
});

describe("dev redirect", () => {
  it.effect("302-redirects loopback navigations to the dev server, preserving the path", () =>
    Effect.gen(function* () {
      const response = yield* rawGet("/settings?tab=updates");
      assert.equal(response.status, 302);
      assert.equal(response.location, "http://127.0.0.1:5173/settings?tab=updates");
    }).pipe(Effect.provide(appLayer({ devWebUrl: new URL("http://127.0.0.1:5173") }))),
  );

  it.effect("does not redirect reserved API paths", () =>
    Effect.gen(function* () {
      const response = yield* rawGet(HEALTH_PATH);
      assert.equal(response.status, 503);
    }).pipe(Effect.provide(appLayer({ devWebUrl: new URL("http://127.0.0.1:5173") }))),
  );
});
