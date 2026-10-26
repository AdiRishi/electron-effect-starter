import { desktopBridge } from "../env";
import { resolveServerTarget } from "./target";

/** Reads the page and the shell's bootstrap on each call, so importing this module reads nothing. */
export const currentServerTarget = () =>
  resolveServerTarget({
    desktop: desktopBridge?.getServerBootstrap() ?? null,
    configuredHttpUrl: import.meta.env.VITE_HTTP_URL ?? "",
    configuredWsUrl: import.meta.env.VITE_WS_URL ?? "",
    origin: window.location.origin,
  });
