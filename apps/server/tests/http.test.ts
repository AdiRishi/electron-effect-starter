import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import { HttpClient, HttpClientRequest, HttpRouter, HttpServerResponse } from "effect/http";

import * as ServerConfig from "../src/config.ts";
import * as ServerHttp from "../src/http.ts";

const makeStaticRequest = Effect.fn("HttpTest.makeStaticRequest")(function* (staticDir: string) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const layerApp = Layer.merge(ServerHttp.layerStaticAndDevRoute, ServerHttp.layerHttpCompression);

  // HttpRouter.serve prefers outer services; inject the test FileSystem between it and NodeHttpServer.layerTest.
  const services = yield* Layer.build(
    HttpRouter.serve(layerApp, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.provideMerge(Layer.succeed(ServerConfig.ServerConfig, { ...config, staticDir })),
      Layer.provideMerge(Layer.succeed(FileSystem.FileSystem, fileSystem)),
      Layer.provideMerge(NodeHttpServer.layerTest),
    ),
  );

  const client = Context.get(services, HttpClient.HttpClient);

  return (resource: string, options?: HttpClientRequest.Options) =>
    client.execute(HttpClientRequest.make(options?.method ?? "GET")(resource, options));
});

const notFoundOnOpen = (candidate: string) =>
  PlatformError.systemError({
    // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- systemError takes the SystemError reason tag as an option.
    _tag: "NotFound",
    module: "FileSystem",
    method: "open",
    pathOrDescriptor: candidate,
  });

describe("browser API CORS", () => {
  it("accepts a preflight with authenticated browser headers", async () => {
    const layerRoute = Layer.effectDiscard(
      Effect.gen(function* () {
        const router = yield* HttpRouter.HttpRouter;
        yield* router.add("GET", "/api/auth/session", HttpServerResponse.empty());
      }),
    );

    const layerApp = Layer.merge(layerRoute, ServerHttp.layerCors).pipe(
      Layer.provide(ServerConfig.layerTest()),
      Layer.provide(NodeServices.layer),
    );

    const { handler, dispose } = HttpRouter.toWebHandler(layerApp, { disableLogger: true });

    try {
      const response = await handler(
        new Request("https://backend.example/api/auth/session", {
          method: "OPTIONS",
          headers: {
            origin: "https://app.example",
            "access-control-request-method": "GET",
            "access-control-request-headers": ["authorization", "content-type"].join(", "),
          },
        }),
      );

      assert.strictEqual(response.status, 204);
      assert.strictEqual(response.headers.get("access-control-allow-origin"), "*");

      const allowedHeaders = new Set(
        (response.headers.get("access-control-allow-headers") ?? "")
          .split(",")
          .map((header) => header.trim().toLowerCase()),
      );

      assert.isTrue(allowedHeaders.has("authorization"));
      assert.isTrue(allowedHeaders.has("content-type"));
    } finally {
      await dispose();
    }
  });
});

describe("static HTTP responses", () => {
  // Real sockets need the live clock.
  it.layer(ServerConfig.layerTest().pipe(Layer.provideMerge(NodeServices.layer)), {
    excludeTestServices: true,
  })((it) => {
    it.effect("revalidates non-HTML files and returns changed contents", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const staticDir = yield* fs.makeTempDirectoryScoped({ prefix: "app-static-cache-" });
        const assetPath = path.join(staticDir, "app.js");
        yield* fs.writeFileString(assetPath, 'export const build = "first";');
        const request = yield* makeStaticRequest(staticDir);

        const initial = yield* request("/app.js");
        assert.strictEqual(initial.status, 200);
        assert.include(yield* initial.text, "first");
        const etag = initial.headers["etag"] ?? "";
        const lastModified = initial.headers["last-modified"] ?? "";
        assert.notStrictEqual(etag, "");
        assert.notStrictEqual(lastModified, "");

        for (const headers of [
          { "if-none-match": etag },
          { "if-none-match": etag.replace(/^W\//, "") },
          { "if-none-match": `"other", ${etag}` },
          { "if-none-match": "*" },
          { "if-modified-since": lastModified },
        ]) {
          const response = yield* request("/app.js", { headers });
          assert.strictEqual(response.status, 304);
          assert.strictEqual(response.headers["etag"], etag);
          assert.strictEqual(response.headers["cache-control"], "no-cache");
          assert.strictEqual(yield* response.text, "");
        }

        const mismatched = yield* request("/app.js", {
          headers: { "if-none-match": '"another-build"', "if-modified-since": lastModified },
        });

        assert.strictEqual(mismatched.status, 200);
        assert.include(yield* mismatched.text, "first");

        yield* fs.writeFileString(assetPath, 'export const build = "the next build";');
        const changed = yield* request("/app.js", { headers: { "if-none-match": etag } });
        assert.strictEqual(changed.status, 200);
        assert.notStrictEqual(changed.headers["etag"], etag);
        assert.include(yield* changed.text, "next build");
      }),
    );

    it.effect("serves static files without handles and skips fallback reads for HEAD and 304", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const staticDir = yield* fs.makeTempDirectoryScoped({ prefix: "app-static-no-open-" });
        const filePath = path.join(staticDir, "app.txt");
        const body = "packaged asset";
        yield* fs.writeFileString(filePath, body);
        let reads = 0;

        // Electron asar files can be statted and read even when opening a handle fails.
        const fileSystem = FileSystem.FileSystem.of({
          ...fs,
          open: (candidate, options) =>
            candidate === filePath
              ? Effect.fail(notFoundOnOpen(candidate))
              : fs.open(candidate, options),
          readFile: (candidate) =>
            Effect.gen(function* () {
              if (candidate === filePath) reads += 1;

              return yield* fs.readFile(candidate);
            }),
        });

        const request = yield* makeStaticRequest(staticDir).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        );

        const get = yield* request("/app.txt");
        assert.strictEqual(get.status, 200);
        assert.strictEqual(yield* get.text, body);
        assert.isAbove(reads, 0);
        const readsAfterGet = reads;
        const head = yield* request("/app.txt", { method: "HEAD" });
        assert.strictEqual(head.status, 200);
        assert.strictEqual(yield* head.text, "");
        assert.strictEqual(reads, readsAfterGet);

        const unchanged = yield* request("/app.txt", {
          headers: { "if-none-match": get.headers["etag"] ?? "" },
        });

        assert.strictEqual(unchanged.status, 304);
        assert.strictEqual(yield* unchanged.text, "");
        assert.strictEqual(reads, readsAfterGet);
      }),
    );

    it.effect("serves replacement bytes with matching static fallback length and validators", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const staticDir = yield* fs.makeTempDirectoryScoped({ prefix: "app-static-replaced-" });
        const filePath = path.join(staticDir, "app.txt");
        const before = DateTime.toDateUtc(DateTime.makeUnsafe("1985-10-26T08:15:00.000Z"));
        const after = DateTime.toDateUtc(DateTime.makeUnsafe("2015-10-21T16:29:00.000Z"));
        const replacement = "the replacement asset";
        const replacementPath = path.join(staticDir, "replacement.txt");
        yield* fs.writeFileString(filePath, "old");
        yield* fs.utimes(filePath, before, before);
        yield* fs.writeFileString(replacementPath, replacement);
        yield* fs.utimes(replacementPath, after, after);
        let replaceOnOpen = false;

        const fileSystem = FileSystem.FileSystem.of({
          ...fs,
          open: (candidate, options) =>
            Effect.gen(function* () {
              if (candidate !== filePath) return yield* fs.open(candidate, options);

              if (replaceOnOpen) {
                yield* fs.rename(replacementPath, filePath);
                replaceOnOpen = false;
              }

              return yield* notFoundOnOpen(candidate);
            }),
        });

        const request = yield* makeStaticRequest(staticDir).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        );

        const initial = yield* request("/app.txt", { headers: { "accept-encoding": "identity" } });
        assert.strictEqual(yield* initial.text, "old");

        replaceOnOpen = true;
        const response = yield* request("/app.txt", { headers: { "accept-encoding": "identity" } });
        assert.strictEqual(response.status, 200);
        assert.strictEqual(
          response.headers["content-length"],
          String(Buffer.byteLength(replacement)),
        );
        assert.strictEqual(response.headers["last-modified"], after.toUTCString());
        assert.notStrictEqual(response.headers["etag"], initial.headers["etag"]);
        assert.strictEqual(yield* response.text, replacement);
      }),
    );

    it.effect("serves changed HTML when deployments preserve its size and timestamp", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const staticDir = yield* fs.makeTempDirectoryScoped({ prefix: "app-static-html-" });
        const indexPath = path.join(staticDir, "index.html");
        const modifiedAt = DateTime.toDateUtc(DateTime.makeUnsafe("1985-10-26T08:15:00.000Z"));
        yield* fs.writeFileString(indexPath, "<html>old build</html>");
        yield* fs.utimes(indexPath, modifiedAt, modifiedAt);
        const request = yield* makeStaticRequest(staticDir);
        const initial = yield* request("/");
        assert.strictEqual(yield* initial.text, "<html>old build</html>");
        const previousEtag = initial.headers["etag"] ?? '"previous-html"';
        const nextHtml = "<html>new build</html>";
        yield* fs.writeFileString(indexPath, nextHtml);
        yield* fs.utimes(indexPath, modifiedAt, modifiedAt);

        for (const [resource, headers] of [
          ["/", { "if-none-match": previousEtag }],
          ["/notes/example", { "if-modified-since": modifiedAt.toUTCString() }],
          ["/", { "if-none-match": "*" }],
        ] as const) {
          const response = yield* request(resource, { headers });
          assert.strictEqual(response.status, 200);
          assert.strictEqual(yield* response.text, nextHtml);
          assert.strictEqual(response.headers["cache-control"], "no-cache");
          assert.isUndefined(response.headers["etag"]);
          assert.isUndefined(response.headers["last-modified"]);
        }

        const head = yield* request("/", {
          method: "HEAD",
          headers: { "if-none-match": previousEtag, "accept-encoding": "identity" },
        });

        assert.strictEqual(head.status, 200);
        assert.strictEqual(head.headers["content-length"], String(Buffer.byteLength(nextHtml)));
        assert.strictEqual(yield* head.text, "");
      }),
    );

    it.effect("closes static descriptors after GET, HEAD, 304, and request cancellation", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const staticDir = yield* fs.makeTempDirectoryScoped({ prefix: "app-static-close-" });
        const filePath = path.join(staticDir, "app.txt");
        const body = "file content\n".repeat(1024);
        yield* fs.writeFileString(filePath, body);
        const closed = yield* Queue.unbounded<FileSystem.File>();
        const blocked = yield* Deferred.make<void>();
        const active = new Set<FileSystem.File>();
        let blockAfterOpen = false;
        let bodyReads = 0;

        const countingReads = (file: FileSystem.File): FileSystem.File => ({
          [FileSystem.FileTypeId]: FileSystem.FileTypeId,
          stat: file.stat,
          seek: (offset, from) => file.seek(offset, from),
          sync: file.sync,
          read: (buffer, options) => file.read(buffer, options),
          readAlloc: (size, options) => {
            bodyReads += 1;

            return file.readAlloc(size, options);
          },
          truncate: (length) => file.truncate(length),
          write: (buffer) => file.write(buffer),
          writeAll: (buffer) => file.writeAll(buffer),
        });

        const trackedFileSystem = FileSystem.FileSystem.of({
          ...fs,
          open: (candidate, options) =>
            Effect.gen(function* () {
              if (candidate !== filePath) return yield* fs.open(candidate, options);
              let opened: FileSystem.File | undefined;

              yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                  if (opened === undefined) return;
                  active.delete(opened);
                  yield* Queue.offer(closed, opened);
                }),
              );

              const file = yield* fs.open(candidate, options);
              opened = file;
              active.add(file);

              if (blockAfterOpen) {
                yield* Deferred.succeed(blocked, undefined);

                return yield* Effect.never;
              }

              return countingReads(file);
            }),
        });

        const request = yield* makeStaticRequest(staticDir).pipe(
          Effect.provideService(FileSystem.FileSystem, trackedFileSystem),
        );

        const get = yield* request("/app.txt");
        assert.strictEqual(yield* get.text, body);
        yield* Queue.take(closed);
        assert.strictEqual(active.size, 0);
        assert.isAbove(bodyReads, 0);
        const readsAfterGet = bodyReads;

        const head = yield* request("/app.txt", {
          method: "HEAD",
          headers: { "accept-encoding": "gzip" },
        });

        assert.strictEqual(head.status, 200);
        assert.strictEqual(head.headers["content-encoding"], "gzip");
        assert.strictEqual(yield* head.text, "");
        yield* Queue.take(closed);
        assert.strictEqual(active.size, 0);
        assert.strictEqual(bodyReads, readsAfterGet);

        const unchanged = yield* request("/app.txt", {
          headers: { "if-none-match": get.headers["etag"] ?? "" },
        });

        assert.strictEqual(unchanged.status, 304);
        yield* Queue.take(closed);
        assert.strictEqual(active.size, 0);
        assert.strictEqual(bodyReads, readsAfterGet);

        blockAfterOpen = true;
        const cancelled = yield* request("/app.txt").pipe(Effect.forkChild);
        yield* Deferred.await(blocked);
        assert.strictEqual(active.size, 1);
        yield* Fiber.interrupt(cancelled);
        yield* Queue.take(closed);
        assert.strictEqual(active.size, 0);
      }),
    );
  });
});
