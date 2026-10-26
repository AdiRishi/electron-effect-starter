import type { DesktopBridge, DesktopServerBootstrap } from "@app/contracts";
import { contextBridge, ipcRenderer } from "electron";

import * as IpcChannels from "./ipc/channels.ts";

// oxlint-disable-next-line app/no-global-process-runtime -- Electron exposes the platform in the sandboxed preload.
const clientPlatform = process.platform;

const bridge: DesktopBridge = {
  getClientPlatform: () => clientPlatform,
  getServerBootstrap: () => {
    const result: unknown = ipcRenderer.sendSync(IpcChannels.GET_SERVER_BOOTSTRAP_CHANNEL);

    return isServerBootstrap(result) ? result : null;
  },
  getBearerToken: () => ipcRenderer.invoke(IpcChannels.GET_BEARER_TOKEN_CHANNEL),
  openExternal: (url) => ipcRenderer.invoke(IpcChannels.OPEN_EXTERNAL_CHANNEL, url),
};

// The main process encodes the result with its schema; this guards the renderer against a
// channel that answered before the server started.
function isServerBootstrap(value: unknown): value is DesktopServerBootstrap {
  return (
    typeof value === "object" &&
    value !== null &&
    "httpBaseUrl" in value &&
    typeof value.httpBaseUrl === "string" &&
    "wsBaseUrl" in value &&
    typeof value.wsBaseUrl === "string"
  );
}

contextBridge.exposeInMainWorld("desktopBridge", bridge);
