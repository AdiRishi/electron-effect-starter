import type { DesktopServerBootstrap } from "@app/contracts";

export interface ServerTarget {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly source: "desktop" | "configured" | "origin";
}

const toWebSocketUrl = (httpUrl: string) => {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};

const toHttpUrl = (wsUrl: string) => {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.toString();
};

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
    return { ...input.desktop, source: "desktop" };
  }
  const httpUrl = input.configuredHttpUrl.trim();
  const wsUrl = input.configuredWsUrl.trim();
  if (httpUrl.length > 0 || wsUrl.length > 0) {
    return {
      httpBaseUrl: httpUrl.length > 0 ? httpUrl : toHttpUrl(wsUrl),
      wsBaseUrl: wsUrl.length > 0 ? wsUrl : toWebSocketUrl(httpUrl),
      source: "configured",
    };
  }
  return { httpBaseUrl: input.origin, wsBaseUrl: toWebSocketUrl(input.origin), source: "origin" };
}
