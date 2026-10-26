import { desktopBridge } from "../env";
import { resolveServerTarget } from "./target";

export const serverTarget = resolveServerTarget({
  desktop: desktopBridge?.getServerBootstrap() ?? null,
  configuredHttpUrl: import.meta.env.VITE_HTTP_URL ?? "",
  configuredWsUrl: import.meta.env.VITE_WS_URL ?? "",
  origin: window.location.origin,
});
