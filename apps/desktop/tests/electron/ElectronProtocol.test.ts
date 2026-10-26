import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  getDesktopUrl,
  makeDesktopRequestHandler,
  type ProtocolFetch,
} from "../../src/electron/ElectronProtocol.ts";

const APP_URL = getDesktopUrl(false);

// Electron's net.fetch is the external seam: this one records requests and answers "ok".
const makeRecordingFetch = () => {
  const calls: Array<{ readonly url: string; readonly headers: Headers }> = [];

  const fetch: ProtocolFetch = (url, init) => {
    calls.push({ url, headers: new Headers(init.headers) });

    return Promise.resolve(new Response("ok"));
  };

  return { calls, fetch };
};

const text = (response: Response) => Effect.promise(() => response.text());

describe("makeDesktopRequestHandler", () => {
  it.effect("serves the bundled client from disk without a backend", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fileSystem.makeTempDirectoryScoped();
      const directory = path.join(base, "client");

      yield* fileSystem.makeDirectory(directory);
      // A real file just outside the assets, which a path traversal would reach.
      yield* fileSystem.writeFileString(path.join(base, "secret.txt"), "secret");
      yield* fileSystem.writeFileString(path.join(directory, "index.html"), "<html>app</html>");
      yield* fileSystem.writeFileString(path.join(directory, "app.js"), "export default 1;");
      const { calls, fetch } = makeRecordingFetch();

      const handle = makeDesktopRequestHandler(
        { scheme: "test", assetDirectory: directory },
        fetch,
      );

      const request = (pathname: string, init?: RequestInit) =>
        handle(new Request(new URL(pathname, APP_URL), init));

      const page = yield* request("/settings/connections");

      assert.strictEqual(yield* text(page), "<html>app</html>");
      assert.include(page.headers.get("content-security-policy") ?? "", "default-src 'self'");
      const dottedRoute = yield* request("/notes/with.dots", { headers: { accept: "text/html" } });

      assert.strictEqual(yield* text(dottedRoute), "<html>app</html>");
      const script = yield* request("/app.js?v=1");

      assert.strictEqual(yield* text(script), "export default 1;");
      assert.include(script.headers.get("content-type") ?? "", "javascript");

      assert.strictEqual((yield* request("/missing.js")).status, 404);
      assert.strictEqual((yield* request("/%2e%2e%2fsecret.txt")).status, 404);
      assert.strictEqual((yield* request("/%invalid")).status, 400);
      assert.strictEqual((yield* request("/", { method: "POST" })).status, 405);
      assert.strictEqual(calls.length, 0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("proxies the stable renderer origin to the dev server", () =>
    Effect.gen(function* () {
      const { calls, fetch } = makeRecordingFetch();

      const handle = makeDesktopRequestHandler(
        { scheme: "test", targetOrigin: new URL("http://127.0.0.1:5733/") },
        fetch,
      );

      const response = yield* handle(
        new Request(new URL("/api/health?verbose=1", APP_URL), {
          headers: {
            accept: "application/json",
            origin: APP_URL,
            referer: APP_URL,
            "sec-fetch-site": "same-origin",
          },
        }),
      );

      assert.strictEqual(yield* text(response), "ok");
      assert.include(response.headers.get("content-security-policy") ?? "", "default-src 'self'");
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0]?.url, "http://127.0.0.1:5733/api/health?verbose=1");
      assert.strictEqual(calls[0]?.headers.get("accept"), "application/json");
      assert.isNull(calls[0]?.headers.get("origin") ?? null);
      assert.isNull(calls[0]?.headers.get("referer") ?? null);
      assert.isNull(calls[0]?.headers.get("sec-fetch-site") ?? null);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects requests for another host", () =>
    Effect.gen(function* () {
      const { calls, fetch } = makeRecordingFetch();
      const otherHost = new URL(APP_URL);

      otherHost.host = "other";

      const proxied = makeDesktopRequestHandler(
        { scheme: "test", targetOrigin: new URL("http://127.0.0.1:5733/") },
        fetch,
      );

      const served = makeDesktopRequestHandler({ scheme: "test", assetDirectory: "/" }, fetch);

      assert.strictEqual((yield* proxied(new Request(otherHost))).status, 404);
      assert.strictEqual((yield* served(new Request(otherHost))).status, 404);
      assert.strictEqual(calls.length, 0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
