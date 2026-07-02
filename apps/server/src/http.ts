import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

/**
 * HTTP routes: health, auth exchange, static SPA + dev redirect, and CORS.
 *
 * @module http
 */
import { BootstrapBearerInput, type BearerSession } from "@app/contracts";

import * as Auth from "./auth.ts";
import * as ServerConfig from "./config.ts";
import * as Readiness from "./readiness.ts";

export const HEALTH_PATH = "/.well-known/app/health";
export const AUTH_BOOTSTRAP_PATH = "/api/auth/bootstrap/bearer";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(normalized);
}

export function resolveDevRedirectUrl(devUrl: URL, requestUrl: URL): string {
  const redirectUrl = new URL(devUrl.toString());
  redirectUrl.pathname = requestUrl.pathname;
  redirectUrl.search = requestUrl.search;
  redirectUrl.hash = requestUrl.hash;
  return redirectUrl.toString();
}

/** Paths that must never be redirected/served as SPA navigations. */
function isReservedPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api") || pathname.startsWith("/ws") || pathname.startsWith("/.well-known")
  );
}

/**
 * CORS. In dev the renderer makes credentialed requests from the Vite origin,
 * so that origin must be explicit; packaged mode uses the default wildcard.
 */
export const corsLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const devOrigin = config.devWebUrl?.origin;
    return HttpRouter.cors({
      ...(devOrigin ? { allowedOrigins: [devOrigin], credentials: true } : {}),
      allowedMethods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Authorization", "Content-Type"],
      maxAge: 600,
    });
  }),
);

/** `GET /.well-known/app/health` — no auth. 200 `ok` once the gate is open, else 503. */
export const healthRouteLayer = HttpRouter.add(
  "GET",
  HEALTH_PATH,
  Effect.gen(function* () {
    const readiness = yield* Readiness.ReadinessGate;
    const ready = yield* readiness.isReady;
    return ready
      ? HttpServerResponse.text("ok", { status: 200 })
      : HttpServerResponse.text("starting", { status: 503 });
  }),
);

/** `POST /api/auth/bootstrap/bearer` — exchange the bootstrap token for a bearer. */
export const authBootstrapRouteLayer = HttpRouter.add(
  "POST",
  AUTH_BOOTSTRAP_PATH,
  Effect.gen(function* () {
    const auth = yield* Auth.BearerSessionStore;
    const input = yield* HttpServerRequest.schemaBodyJson(BootstrapBearerInput).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (input === null) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const minted = yield* auth.authenticateBootstrap(input.credential);
    if (Option.isNone(minted)) {
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }

    const session: BearerSession = {
      access_token: minted.value,
      expires_at: null,
    };
    return yield* HttpServerResponse.json(session, { status: 200 });
  }),
);

/** `GET *` — SPA static serving with `index.html` fallback, plus dev redirect. */
export const staticAndDevRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig.ServerConfig;

    // Dev: 302-redirect navigations (not reserved paths) to the Vite dev server.
    if (
      config.devWebUrl &&
      !isReservedPath(url.value.pathname) &&
      isLoopbackHostname(url.value.hostname)
    ) {
      return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devWebUrl, url.value), {
        status: 302,
      });
    }

    const staticDir = config.staticDir ?? (yield* ServerConfig.resolveStaticDir());
    if (!staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(staticDir);
    const requestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawRelative = requestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParent = rawRelative.startsWith("..");
    const relative = path.normalize(rawRelative).replace(/^[/\\]+/, "");
    if (
      relative.length === 0 ||
      hasRawLeadingParent ||
      relative.startsWith("..") ||
      relative.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", {
        status: 400,
      });
    }

    const isWithinRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, relative);
    if (!isWithinRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", {
        status: 400,
      });
    }
    if (!path.extname(filePath)) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", {
          status: 400,
        });
      }
    }

    const info = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
    if (!info || info.type !== "File") {
      // SPA fallback: serve index.html for unknown routes.
      const indexData = yield* fileSystem
        .readFile(path.resolve(staticRoot, "index.html"))
        .pipe(Effect.orElseSucceed(() => null));
      if (!indexData) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      return HttpServerResponse.uint8Array(indexData, {
        status: 200,
        contentType: "text/html; charset=utf-8",
      });
    }

    return yield* HttpServerResponse.file(filePath, { status: 200 }).pipe(
      Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
    );
  }),
);
