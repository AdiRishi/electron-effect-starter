import { DESKTOP_RENDERER_ORIGINS } from "@app/contracts";
import { getPairingTokenFromUrl } from "@app/shared/pairingUrl";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/http";

import * as BootstrapCredentials from "../../src/auth/BootstrapCredentials.ts";
import * as ServerAuth from "../../src/auth/ServerAuth.ts";
import * as ServerSecretStore from "../../src/auth/ServerSecretStore.ts";
import * as SessionStore from "../../src/auth/SessionStore.ts";
import * as ServerConfig from "../../src/config.ts";
import * as Sqlite from "../../src/persistence/Sqlite.ts";

const TEST_SERVER_PORT = 13_773;

const layerServerAuth = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  ServerAuth.layer.pipe(
    Layer.provideMerge(BootstrapCredentials.layer),
    Layer.provideMerge(SessionStore.layer),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(Sqlite.layerConfig),
    Layer.provide(
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;

          return {
            ...config,
            ...overrides,
            port: TEST_SERVER_PORT,
          } satisfies ServerConfig.ServerConfig["Service"];
        }),
      ).pipe(Layer.provide(ServerConfig.layerTest())),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const makeRequest = (url: string, headers: Record<string, string>) =>
  HttpServerRequest.fromWeb(new Request(url, { headers }));

const pairBrowser = Effect.gen(function* () {
  const credentials = yield* BootstrapCredentials.BootstrapCredentials;
  const serverAuth = yield* ServerAuth.ServerAuth;
  const { credential } = yield* credentials.issueOneTimeToken;

  return yield* serverAuth.createBrowserSession(credential);
});

describe("ServerAuth", () => {
  it.effect("accepts cookie sessions on socket upgrades only from the app's own origins", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth.ServerAuth;
      const sessions = yield* SessionStore.SessionStore;
      const exchanged = yield* pairBrowser;

      const upgrade = (headers: Record<string, string>) =>
        serverAuth.authenticateWebSocketUpgrade(
          makeRequest("http://192.168.1.50:3773/ws", {
            host: "192.168.1.50:3773",
            cookie: `${sessions.cookieName}=${exchanged.sessionToken}`,
            ...headers,
          }),
        );

      yield* upgrade({ origin: "http://192.168.1.50:3773" });

      yield* upgrade({
        origin: "https://box.tail1234.ts.net",
        "x-forwarded-host": "box.tail1234.ts.net",
      });

      for (const origin of DESKTOP_RENDERER_ORIGINS) yield* upgrade({ origin });
      yield* upgrade({ origin: "http://localhost:5733" });
      yield* upgrade({});

      const otherPort = yield* Effect.flip(upgrade({ origin: "http://192.168.1.50:8080" }));
      assert.strictEqual(otherPort._tag, "ServerAuthInvalidCredentialError");
      const opaque = yield* Effect.flip(upgrade({ origin: "null" }));
      assert.strictEqual(opaque._tag, "ServerAuthInvalidCredentialError");
    }).pipe(
      Effect.provide(
        layerServerAuth({
          mode: "web",
          host: "192.168.1.50",
          devUrl: new URL("http://localhost:5733"),
        }),
      ),
    ),
  );

  it.effect("accepts cookie sessions on HTTP requests only from the app's own origins", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth.ServerAuth;
      const sessions = yield* SessionStore.SessionStore;
      const exchanged = yield* pairBrowser;
      const cookie = `${sessions.cookieName}=${exchanged.sessionToken}`;

      const post = (headers: Record<string, string>) =>
        serverAuth.authenticateRequest(
          makeRequest("http://localhost:13773/api/auth/websocket-ticket", {
            host: "localhost:13773",
            cookie,
            ...headers,
          }),
        );

      yield* post({ origin: "http://192.168.1.50:5733", "sec-fetch-site": "same-origin" });
      yield* post({ origin: "http://localhost:13773" });

      const otherPort = yield* Effect.flip(
        post({ origin: "http://localhost:3000", "sec-fetch-site": "same-site" }),
      );

      assert.strictEqual(otherPort._tag, "ServerAuthInvalidCredentialError");

      const state = yield* serverAuth.getSessionState(
        makeRequest("http://localhost:13773/api/auth/session", {
          host: "localhost:13773",
          cookie,
          origin: "http://localhost:3000",
        }),
      );

      assert.isFalse(state.authenticated);
    }).pipe(Effect.provide(layerServerAuth({ mode: "web" }))),
  );

  it.effect("keeps bearer socket upgrades independent of the page origin", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth.ServerAuth;
      const sessions = yield* SessionStore.SessionStore;
      const bearer = yield* sessions.issue({ method: "bearer-access-token" });

      const verified = yield* serverAuth.authenticateWebSocketUpgrade(
        makeRequest("http://192.168.1.50:3773/ws", {
          origin: "http://192.168.1.50:8080",
          authorization: `Bearer ${bearer.token}`,
        }),
      );

      assert.strictEqual(verified.sessionId, bearer.sessionId);
    }).pipe(Effect.provide(layerServerAuth({ mode: "web", host: "192.168.1.50" }))),
  );

  it.effect("issues startup pairing URLs that bootstrap browser sessions", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth.ServerAuth;
      const sessions = yield* SessionStore.SessionStore;

      const pairingUrl = yield* serverAuth.issueStartupPairingUrl("http://127.0.0.1:3773");
      const token = getPairingTokenFromUrl(new URL(pairingUrl));
      assert.isNotNull(token);

      const exchanged = yield* serverAuth.createBrowserSession(token ?? "");

      const verified = yield* serverAuth.authenticateRequest(
        makeRequest("http://127.0.0.1:3773/api/auth/session", {
          cookie: `${sessions.cookieName}=${exchanged.sessionToken}`,
        }),
      );

      assert.strictEqual(verified.method, "browser-session-cookie");

      const reused = yield* Effect.flip(serverAuth.createBrowserSession(token ?? ""));
      assert.strictEqual(reused._tag, "ServerAuthInvalidCredentialError");
    }).pipe(Effect.provide(layerServerAuth())),
  );

  it.effect("replaces the browser session a signed-in browser pairs again from", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth.ServerAuth;
      const credentials = yield* BootstrapCredentials.BootstrapCredentials;
      const sessions = yield* SessionStore.SessionStore;
      const first = yield* pairBrowser;
      const { credential } = yield* credentials.issueOneTimeToken;
      const second = yield* serverAuth.createBrowserSession(credential, first.sessionToken);

      const firstError = yield* Effect.flip(sessions.verify(first.sessionToken));
      assert.strictEqual(firstError._tag, "SessionTokenRevokedError");
      yield* sessions.verify(second.sessionToken);
    }).pipe(Effect.provide(layerServerAuth())),
  );

  it.effect("rotates desktop bearer sessions without accumulating authorized clients", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth.ServerAuth;
      const sessions = yield* SessionStore.SessionStore;
      const browser = yield* serverAuth.createBrowserSession("desktop-bootstrap-token");

      const staleSessions = yield* Effect.forEach([1, 2, 3], () =>
        sessions.issue({ subject: "desktop-bootstrap", method: "bearer-access-token" }),
      );

      const paired = yield* pairBrowser;
      const first = yield* serverAuth.exchangeBootstrapCredential("desktop-bootstrap-token");
      const second = yield* serverAuth.exchangeBootstrapCredential("desktop-bootstrap-token");

      const bearer = (token: string) =>
        serverAuth.authenticateRequest(
          makeRequest("http://127.0.0.1:3773/api/auth/websocket-ticket", {
            authorization: `Bearer ${token}`,
          }),
        );

      const firstError = yield* bearer(first.access_token).pipe(Effect.flip);
      assert.strictEqual(firstError._tag, "ServerAuthInvalidCredentialError");
      yield* bearer(second.access_token);
      yield* sessions.verify(browser.sessionToken);
      yield* sessions.verify(paired.sessionToken);

      for (const stale of staleSessions) {
        const error = yield* sessions.verify(stale.token).pipe(Effect.flip);
        assert.strictEqual(error._tag, "SessionTokenRevokedError");
      }
    }).pipe(Effect.provide(layerServerAuth({ desktopBootstrapToken: "desktop-bootstrap-token" }))),
  );
});
