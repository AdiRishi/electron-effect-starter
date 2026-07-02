/**
 * True when running inside the Electron shell. `preload.ts` installs
 * `window.desktopBridge` via contextBridge before any app code runs, so this is
 * reliable at module-load time.
 */
export const isElectron = typeof window !== "undefined" && window.desktopBridge !== undefined;

export interface ConnectionTarget {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

/** Turn a ws(s) URL into its http(s) origin form. */
export function toHttpOrigin(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/** Turn an http(s) origin into its ws(s) form. */
export function toWsOrigin(httpUrl: string): string {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/**
 * Resolve where the server lives (integration contract):
 * - In the shell: ask the bridge; fall back to `window.location.origin`.
 * - In the browser: derive from `VITE_WS_URL`.
 */
export function resolveConnectionTarget(): ConnectionTarget {
  if (isElectron && window.desktopBridge) {
    const bootstrap = window.desktopBridge.getServerBootstrap();
    if (bootstrap) {
      return {
        httpBaseUrl: bootstrap.httpBaseUrl,
        wsBaseUrl: bootstrap.wsBaseUrl,
      };
    }
    const httpBaseUrl = window.location.origin;
    return { httpBaseUrl, wsBaseUrl: toWsOrigin(httpBaseUrl) };
  }

  const wsBaseUrl = import.meta.env.VITE_WS_URL;
  return { httpBaseUrl: toHttpOrigin(wsBaseUrl), wsBaseUrl };
}
