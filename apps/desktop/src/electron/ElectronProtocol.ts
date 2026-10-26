import { DESKTOP_DEV_SCHEME, DESKTOP_SCHEME } from "@app/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Mime from "effect/http/Mime";

import * as Electron from "electron";

export const DESKTOP_HOST = "app";

export function getDesktopScheme(isDevelopment: boolean): string {
  return isDevelopment ? DESKTOP_DEV_SCHEME : DESKTOP_SCHEME;
}

export function getDesktopUrl(isDevelopment: boolean): string {
  return `${getDesktopScheme(isDevelopment)}://${DESKTOP_HOST}/`;
}

export class ElectronProtocolRegistrationError extends Schema.TaggedError<ElectronProtocolRegistrationError>()(
  "ElectronProtocolRegistrationError",
  { scheme: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to register the Electron protocol scheme "${this.scheme}".`;
  }
}

export type DesktopProtocolRegistrationInput = { readonly scheme: string } & (
  | { readonly targetOrigin: URL }
  | { readonly assetDirectory: string }
);

export class ElectronProtocol extends Context.Service<
  ElectronProtocol,
  {
    readonly registerDesktopProtocol: (
      input: DesktopProtocolRegistrationInput,
    ) => Effect.Effect<void, ElectronProtocolRegistrationError, Scope.Scope>;
  }
>()("@app/desktop/electron/ElectronProtocol") {}

// The renderer only talks to its own scheme and the loopback server the shell supervises.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*",
  "img-src 'self' blob: data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "form-action 'self'",
].join("; ");

function withContentSecurityPolicy(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Must run synchronously, before Electron emits ready. */
export function registerSchemePrivileges(): void {
  Electron.protocol.registerSchemesAsPrivileged([
    {
      scheme: DESKTOP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        // Custom schemes must opt into V8 caching; dev URLs serve changing code.
        codeCache: true,
      },
    },
    {
      scheme: DESKTOP_DEV_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

class ElectronProtocolFetchError extends Schema.TaggedError<ElectronProtocolFetchError>()(
  "ElectronProtocolFetchError",
  { cause: Schema.Defect() },
) {}

const netFetch = (url: string, init: RequestInit) =>
  Effect.tryPromise({
    try: () => Electron.net.fetch(url, init),
    catch: (cause) => new ElectronProtocolFetchError({ cause }),
  });

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  "host",
  "origin",
  "referer",
  "connection",
  "content-length",
  "accept-encoding",
  "upgrade-insecure-requests",
]);

/** In development the scheme proxies the Vite dev server, so the renderer origin matches production. */
const proxyRequest = Effect.fn("ElectronProtocol.proxyRequest")(function* (
  request: Request,
  targetOrigin: URL,
) {
  const requestUrl = new URL(request.url);

  if (requestUrl.host !== DESKTOP_HOST) return new Response(null, { status: 404 });

  const targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, targetOrigin);
  const headers = new Headers(request.headers);

  // Collect first: deleting while iterating Headers skips entries.
  const removable = Array.from(headers.keys()).filter(
    (name) => HOP_BY_HOP_REQUEST_HEADERS.has(name) || name.startsWith("sec-fetch-"),
  );

  for (const name of removable) headers.delete(name);
  const isRead = request.method === "GET" || request.method === "HEAD";

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    ...(isRead ? {} : { body: request.body, duplex: "half" }),
  };

  const response = isRead
    ? yield* netFetch(targetUrl.toString(), init).pipe(
        // Vite restarts briefly drop connections; retry reads only.
        Effect.retry({ schedule: Schedule.exponential("50 millis", 3), times: 2 }),
      )
    : yield* netFetch(targetUrl.toString(), init);

  return withContentSecurityPolicy(response);
});

const serveDesktopAsset = Effect.fn("ElectronProtocol.serveAsset")(function* (
  request: Request,
  assetDirectory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const url = new URL(request.url);

  if (url.host !== DESKTOP_HOST) return new Response(null, { status: 404 });

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405 });
  }

  const pathname = yield* Effect.try(() => decodeURIComponent(url.pathname)).pipe(
    Effect.orElseSucceed(() => null),
  );

  if (pathname === null || pathname.includes("\0")) return new Response(null, { status: 400 });
  const root = path.resolve(assetDirectory);
  const assetPath = path.resolve(root, `.${pathname}`);

  if (assetPath !== root && !assetPath.startsWith(root + path.sep)) {
    return new Response(null, { status: 404 });
  }

  const stat = yield* fileSystem.stat(assetPath).pipe(Effect.orElseSucceed(() => null));
  let filePath = assetPath;

  if (stat?.type !== "File") {
    // Unknown files with an extension are real 404s; extensionless paths are app routes.
    const wantsHtml = request.headers.get("accept")?.includes("text/html") ?? false;

    if (path.extname(assetPath) !== "" && !wantsHtml) return new Response(null, { status: 404 });
    filePath = path.join(root, "index.html");
  }

  const contents = yield* fileSystem.readFile(filePath).pipe(Effect.orElseSucceed(() => null));

  if (contents === null) return new Response(null, { status: 404 });

  return withContentSecurityPolicy(
    new Response(request.method === "HEAD" ? null : new Uint8Array(contents), {
      headers: {
        "content-type": Option.getOrElse(Mime.getType(filePath), () => "application/octet-stream"),
      },
    }),
  );
});

const make = Effect.gen(function* () {
  const registered = yield* Ref.make(false);
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const runPromise = Effect.runPromiseWith(context);

  const registerDesktopProtocol = Effect.fn("ElectronProtocol.registerDesktopProtocol")(function* (
    input: DesktopProtocolRegistrationInput,
  ) {
    if (yield* Ref.get(registered)) return;
    yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Electron.protocol.handle(input.scheme, (request) =>
            runPromise(
              "assetDirectory" in input
                ? serveDesktopAsset(request, input.assetDirectory)
                : proxyRequest(request, input.targetOrigin).pipe(
                    Effect.catchTags({
                      ElectronProtocolFetchError: (error) => Effect.die(error.cause),
                    }),
                  ),
            ),
          ),
        catch: (cause) => new ElectronProtocolRegistrationError({ scheme: input.scheme, cause }),
      }).pipe(Effect.andThen(Ref.set(registered, true))),
      () =>
        Effect.sync(() => Electron.protocol.unhandle(input.scheme)).pipe(
          Effect.andThen(Ref.set(registered, false)),
        ),
    );
  });

  return ElectronProtocol.of({ registerDesktopProtocol });
});

export const layer = Layer.effect(ElectronProtocol, make);
