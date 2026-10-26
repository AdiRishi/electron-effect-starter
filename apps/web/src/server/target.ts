import type { DesktopServerBootstrap } from "@app/contracts";
import * as Schema from "effect/Schema";

const ServerTargetSource = Schema.Literals(["desktop", "configured", "origin"]);

type ServerTargetSource = typeof ServerTargetSource.Type;

const ServerUrlKind = Schema.Literals(["http-base-url", "websocket-base-url", "page-origin"]);

type ServerUrlKind = typeof ServerUrlKind.Type;

export class ServerUrlInvalidError extends Schema.TaggedError<ServerUrlInvalidError>()(
  "ServerUrlInvalidError",
  {
    source: ServerTargetSource,
    urlKind: ServerUrlKind,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not parse the ${this.urlKind} for the ${this.source} server target.`;
  }
}

export class ServerProtocolUnsupportedError extends Schema.TaggedError<ServerProtocolUnsupportedError>()(
  "ServerProtocolUnsupportedError",
  {
    source: ServerTargetSource,
    protocol: Schema.String,
  },
) {
  override get message(): string {
    return `The ${this.source} server target uses unsupported protocol ${this.protocol}.`;
  }
}

export interface ServerTarget {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly source: ServerTargetSource;
}

function parseTargetUrl(input: {
  readonly rawValue: string;
  readonly baseUrl?: string;
  readonly source: ServerTargetSource;
  readonly urlKind: ServerUrlKind;
}): URL {
  try {
    return input.baseUrl === undefined
      ? new URL(input.rawValue)
      : new URL(input.rawValue, input.baseUrl);
  } catch (cause) {
    throw new ServerUrlInvalidError({ source: input.source, urlKind: input.urlKind, cause });
  }
}

// Relative URLs, such as a path configured at build time, resolve against the page.
function normalizeBaseUrl(
  rawValue: string,
  origin: string,
  source: ServerTargetSource,
  urlKind: ServerUrlKind,
): string {
  return parseTargetUrl({ rawValue, baseUrl: origin, source, urlKind }).toString();
}

function swapBaseUrlProtocol(
  rawValue: string,
  origin: string,
  nextProtocol: "http:" | "https:" | "ws:" | "wss:",
  urlKind: ServerUrlKind,
): string {
  const url = parseTargetUrl({ rawValue, baseUrl: origin, source: "configured", urlKind });
  url.protocol = nextProtocol;

  return url.toString();
}

function resolveConfiguredTarget(
  configuredHttpUrl: string,
  configuredWsUrl: string,
  origin: string,
): ServerTarget | null {
  const configuredHttpBaseUrl = configuredHttpUrl.trim() || undefined;
  const configuredWsBaseUrl = configuredWsUrl.trim() || undefined;

  if (!configuredHttpBaseUrl && !configuredWsBaseUrl) {
    return null;
  }

  // Match URL scheme case-folding so uppercase WSS cannot downgrade to plaintext.
  const resolvedHttpBaseUrl =
    configuredHttpBaseUrl ??
    (configuredWsBaseUrl?.toLowerCase().startsWith("wss:")
      ? swapBaseUrlProtocol(configuredWsBaseUrl, origin, "https:", "websocket-base-url")
      : swapBaseUrlProtocol(configuredWsBaseUrl!, origin, "http:", "websocket-base-url"));

  const resolvedWsBaseUrl =
    configuredWsBaseUrl ??
    (configuredHttpBaseUrl?.toLowerCase().startsWith("https:")
      ? swapBaseUrlProtocol(configuredHttpBaseUrl, origin, "wss:", "http-base-url")
      : swapBaseUrlProtocol(configuredHttpBaseUrl!, origin, "ws:", "http-base-url"));

  return {
    httpBaseUrl: normalizeBaseUrl(resolvedHttpBaseUrl, origin, "configured", "http-base-url"),
    wsBaseUrl: normalizeBaseUrl(resolvedWsBaseUrl, origin, "configured", "websocket-base-url"),
    source: "configured",
  };
}

function resolveOriginTarget(origin: string): ServerTarget {
  const url = parseTargetUrl({ rawValue: origin, source: "origin", urlKind: "page-origin" });
  const httpBaseUrl = url.toString();

  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else {
    throw new ServerProtocolUnsupportedError({ source: "origin", protocol: url.protocol });
  }

  return { httpBaseUrl, wsBaseUrl: url.toString(), source: "origin" };
}

/**
 * The desktop shell's server wins, then a URL configured at build time, then the page's own
 * origin. Dev and the server's own static build are single-origin, so they use the last.
 */
export function resolveServerTarget(input: {
  readonly desktop: DesktopServerBootstrap | null;
  readonly configuredHttpUrl: string;
  readonly configuredWsUrl: string;
  readonly origin: string;
}): ServerTarget {
  if (input.desktop !== null) {
    return {
      httpBaseUrl: normalizeBaseUrl(
        input.desktop.httpBaseUrl,
        input.origin,
        "desktop",
        "http-base-url",
      ),
      wsBaseUrl: normalizeBaseUrl(
        input.desktop.wsBaseUrl,
        input.origin,
        "desktop",
        "websocket-base-url",
      ),
      source: "desktop",
    };
  }

  return (
    resolveConfiguredTarget(input.configuredHttpUrl, input.configuredWsUrl, input.origin) ??
    resolveOriginTarget(input.origin)
  );
}
