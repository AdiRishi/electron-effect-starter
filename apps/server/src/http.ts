import { AppHttpApi, DESKTOP_RENDERER_ORIGINS } from "@app/contracts";
import { isDevProxiedPath } from "@app/shared/devProxy";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Mime from "effect/http/Mime";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ServerConfig from "./config.ts";
import { serverDescriptor } from "./descriptor.ts";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);

export const layerMetadata = HttpApiBuilder.group(AppHttpApi, "metadata", (handlers) =>
  handlers.handle("descriptor", () => serverDescriptor),
);

export const layerHttpCompression = HttpRouter.middleware(HttpMiddleware.compression(), {
  global: true,
});

export const layerCors = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const devOrigin = config.devUrl?.origin;
    // Credentialed dev requests need explicit origins; the packaged desktop renderer sends a
    // bearer header, which the default wildcard allows.
    return HttpRouter.cors({
      ...(devOrigin
        ? { allowedOrigins: [devOrigin, ...DESKTOP_RENDERER_ORIGINS], credentials: true }
        : {}),
      allowedMethods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["authorization", "content-type", "traceparent", "b3"],
      maxAge: 600,
    });
  }),
);

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(
    hostname
      .trim()
      .toLowerCase()
      .replace(/^\[(.*)\]$/, "$1"),
  );
}

function resolveDevRedirectUrl(devUrl: URL, requestUrl: URL): string {
  const redirectUrl = new URL(devUrl.toString());
  redirectUrl.pathname = requestUrl.pathname;
  redirectUrl.search = requestUrl.search;
  redirectUrl.hash = requestUrl.hash;
  return redirectUrl.toString();
}

const decodeBuildManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        file: Schema.String,
        css: Schema.optional(Schema.Array(Schema.String)),
        assets: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
  ),
);

const loadImmutableBuildAssets = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  if (!config.staticDir) return new Set<string>();
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem
    .readFileString(path.join(config.staticDir, ".vite", "manifest.json"))
    .pipe(
      Effect.flatMap(decodeBuildManifest),
      Effect.map(
        (manifest) =>
          new Set(
            Object.values(manifest).flatMap((entry) => [
              entry.file,
              ...(entry.css ?? []),
              ...(entry.assets ?? []),
            ]),
          ),
      ),
      Effect.orElseSucceed(() => new Set<string>()),
    );
});

const openStaticFile = Effect.fn("openStaticFile")(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathInfo = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
  if (pathInfo?.type !== "File") return null;
  const file = yield* fileSystem.open(filePath, { flag: "r" }).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
    }),
  );
  // Electron asar can stat and read files even when opening a handle returns NotFound.
  // Refresh path metadata because the file may have been replaced since the first stat.
  const info = yield* file === null ? fileSystem.stat(filePath) : file.stat;
  return info.type === "File" ? { file, info } : null;
});

// Per-chunk reads share the request span.
const streamStaticFile = (file: FileSystem.File, size: bigint) =>
  Stream.unfold(
    0n,
    Effect.fnUntraced(function* (offset: bigint) {
      if (offset >= size) return;
      const remaining = size - offset;
      const bytes = yield* file.readAlloc(Number(remaining < 65_536n ? remaining : 65_536n));
      if (Option.isNone(bytes)) return;
      return [bytes.value, offset + BigInt(bytes.value.byteLength)] as const;
    }),
  );

const handleStaticAndDevRequest = Effect.fn("handleStaticAndDevRequest")(
  function* (immutableBuildAssets: ReadonlySet<string>) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig.ServerConfig;
    if (config.devUrl && isDevProxiedPath(url.value.pathname)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    if (config.devUrl && isLoopbackHostname(url.value.hostname)) {
      return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devUrl, url.value), {
        status: 302,
      });
    }
    if (!config.staticDir) {
      return HttpServerResponse.text("No web build found and no dev URL set.", { status: 503 });
    }

    const path = yield* Path.Path;
    const staticRoot = path.resolve(config.staticDir);
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    if (
      staticRelativePath.length === 0 ||
      rawStaticRelativePath.startsWith("..") ||
      staticRelativePath.startsWith("..") ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }
    if (!path.extname(filePath)) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    let opened = yield* openStaticFile(filePath);
    if (!opened) {
      filePath = path.resolve(staticRoot, "index.html");
      opened = yield* openStaticFile(filePath);
      if (!opened) return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const fileInfo = opened.info;
    const mimeType = Option.getOrElse(Mime.getType(filePath), () => "application/octet-stream");
    const isHtml = mimeType === "text/html";

    // A hash-like name is not enough: custom static files can use the same naming pattern.
    const relativePath = path.relative(staticRoot, filePath).replaceAll("\\", "/");
    const immutable =
      !isHtml &&
      /^assets\/.+-[\w-]{8}\.[^/]+$/.test(relativePath) &&
      immutableBuildAssets.has(relativePath);
    const cacheControl = immutable ? "public, max-age=31536000, immutable" : "no-cache";
    const validators = (info: FileSystem.File.Info) => {
      // Deployments can preserve HTML size and mtime while changing its bundle URLs.
      const modifiedAt = isHtml ? undefined : Option.getOrUndefined(info.mtime);
      return modifiedAt
        ? {
            ETag: `W/"${info.size.toString(16)}-${modifiedAt.getTime().toString(16)}"`,
            "Last-Modified": modifiedAt.toUTCString(),
          }
        : {};
    };
    const headers: Record<string, string> = {
      "Cache-Control": cacheControl,
      ...validators(fileInfo),
    };
    const etag = headers.ETag;
    const lastModified = headers["Last-Modified"];

    // If-None-Match precedes dates and uses weak GET/HEAD comparison even across compression.
    const ifNoneMatch = request.headers["if-none-match"];
    const ifModifiedSince = request.headers["if-modified-since"];
    const unchanged =
      ifNoneMatch !== undefined
        ? ifNoneMatch.split(",").some((value) => {
            const candidate = value.trim();
            return (
              candidate === "*" ||
              (etag !== undefined && candidate.replace(/^W\//i, "") === etag.slice(2))
            );
          })
        : ifModifiedSince !== undefined &&
          lastModified !== undefined &&
          Date.parse(lastModified) <= Date.parse(ifModifiedSince);
    if (!isHtml && unchanged) {
      return HttpServerResponse.empty({
        status: 304,
        headers: { ...headers, Vary: "Accept-Encoding" },
      });
    }

    const contentType = isHtml ? "text/html; charset=utf-8" : mimeType;
    if (opened.file === null && request.method !== "HEAD") {
      const fileSystem = yield* FileSystem.FileSystem;
      // Complete fallback reads before success headers; stream errors arrive too late for a 500.
      const bytes = yield* fileSystem.readFile(filePath);
      const info = yield* fileSystem.stat(filePath);
      return HttpServerResponse.uint8Array(bytes, {
        headers: {
          "Cache-Control": cacheControl,
          ...validators({ ...info, size: ByteSize.bytes(bytes.byteLength) }),
        },
        contentType,
      });
    }
    // The request scope closes the handle for GET, HEAD, 304, errors, and cancellation.
    return HttpServerResponse.stream(
      opened.file === null ? Stream.empty : streamStaticFile(opened.file, fileInfo.size),
      { headers, contentType, contentLength: Number(fileInfo.size) },
    );
  },
  Effect.catchTags({
    PlatformError: () =>
      Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
  }),
);

export const layerStaticAndDevRoute = Layer.unwrap(
  loadImmutableBuildAssets.pipe(
    Effect.map((assets) => HttpRouter.add("GET", "*", handleStaticAndDevRequest(assets))),
  ),
);
