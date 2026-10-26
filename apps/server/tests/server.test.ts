import {
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthBootstrapTokenType,
  AuthTokenExchangeGrantType,
  AuthWebSocketTicketResult,
  ServerDescriptor,
} from "@app/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClientRequest, HttpClientResponse } from "effect/http";

import { connectRpc, makeTestServer } from "./support/testServer.ts";

const DESKTOP_TOKEN = "desktop-bootstrap-token-for-tests";

const decodeDescriptor = HttpClientResponse.schemaBodyJson(ServerDescriptor);
const decodeAccessToken = HttpClientResponse.schemaBodyJson(AuthAccessTokenResult);
const decodeTicket = HttpClientResponse.schemaBodyJson(AuthWebSocketTicketResult);
const decodeErrorTag = HttpClientResponse.schemaBodyJson(Schema.Struct({ _tag: Schema.String }));

describe("server", () => {
  // Real sockets need the live clock.
  it.layer(NodeServices.layer, { excludeTestServices: true })((it) => {
    it.effect("describes itself without credentials", () =>
      Effect.gen(function* () {
        const { client } = yield* makeTestServer();

        const descriptor = yield* client
          .get("/.well-known/app/server")
          .pipe(Effect.flatMap(decodeDescriptor));

        assert.strictEqual(descriptor.name, "@app/server");
      }),
    );

    it.effect("refuses a WebSocket upgrade without a credential", () =>
      Effect.gen(function* () {
        const { client } = yield* makeTestServer();
        const response = yield* client.get("/ws");
        assert.strictEqual(response.status, 401);
        assert.strictEqual((yield* decodeErrorTag(response))._tag, "AuthInvalidError");
      }),
    );

    it.effect("rejects a bootstrap credential it did not issue", () =>
      Effect.gen(function* () {
        const { client } = yield* makeTestServer({ desktopBootstrapToken: DESKTOP_TOKEN });

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
      }),
    );

    it.effect("serves RPC to a desktop renderer that trades its bootstrap token for a ticket", () =>
      Effect.gen(function* () {
        const { client, baseUrl } = yield* makeTestServer({ desktopBootstrapToken: DESKTOP_TOKEN });

        const { access_token } = yield* client
          .execute(
            HttpClientRequest.post("/oauth/token").pipe(
              HttpClientRequest.bodyUrlParams({
                grant_type: AuthTokenExchangeGrantType,
                subject_token: DESKTOP_TOKEN,
                subject_token_type: AuthBootstrapTokenType,
                requested_token_type: AuthAccessTokenType,
              }),
            ),
          )
          .pipe(Effect.flatMap(decodeAccessToken));

        const { ticket } = yield* client
          .execute(
            HttpClientRequest.post("/api/auth/websocket-ticket").pipe(
              HttpClientRequest.bearerToken(access_token),
            ),
          )
          .pipe(Effect.flatMap(decodeTicket));

        const rpc = yield* connectRpc(baseUrl, ticket);
        const created = yield* rpc["notes.create"]({ title: "From the renderer", body: "" });

        const [snapshot] = yield* rpc["notes.subscribe"]({}).pipe(
          Stream.take(1),
          Stream.runCollect,
        );

        assert.deepStrictEqual(
          snapshot?.type === "snapshot" ? snapshot.notes.map((note) => note.id) : [],
          [created.id],
        );
      }),
    );

    it.effect("serves the web build with an SPA fallback and refuses paths outside it", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const staticDir = yield* fs.makeTempDirectoryScoped({ prefix: "app-static-" });
        yield* fs.writeFileString(path.join(staticDir, "index.html"), "<!doctype html><p>app</p>");
        const { client } = yield* makeTestServer({ staticDir });

        const deepLink = yield* client.get("/notes/123");
        assert.strictEqual(deepLink.status, 200);
        assert.include(yield* deepLink.text, "<p>app</p>");

        const traversal = yield* client.get("/..%2f..%2fetc%2fpasswd");
        assert.strictEqual(traversal.status, 400);
      }),
    );
  });
});
