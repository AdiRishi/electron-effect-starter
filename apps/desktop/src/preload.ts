import type { DesktopBridge } from "@app/contracts";
import { contextBridge, ipcRenderer } from "electron";

import * as IpcChannels from "./ipc/channels.ts";

// The context-isolation bridge. Each method delegates to `ipcRenderer` and the
// object is typed with `satisfies DesktopBridge`, so main, preload, and renderer
// all share the one contract. Sync methods use `sendSync`; everything else uses
// `invoke` (returns a Promise). Push channels (`on*`) subscribe with
// `ipcRenderer.on` and return an unsubscribe.

contextBridge.exposeInMainWorld("desktopBridge", {
  getAppInfo: () => {
    const result = ipcRenderer.sendSync(IpcChannels.GET_APP_INFO_CHANNEL);
    if (typeof result !== "object" || result === null) {
      return null;
    }
    return result as ReturnType<DesktopBridge["getAppInfo"]>;
  },
  getServerBootstrap: () => {
    const result = ipcRenderer.sendSync(IpcChannels.GET_SERVER_BOOTSTRAP_CHANNEL);
    if (typeof result !== "object" || result === null) {
      return null;
    }
    return result as ReturnType<DesktopBridge["getServerBootstrap"]>;
  },
  getBearerToken: () => ipcRenderer.invoke(IpcChannels.GET_BEARER_TOKEN_CHANNEL),

  setTheme: (theme) => ipcRenderer.invoke(IpcChannels.SET_THEME_CHANNEL, theme),
  openExternal: (url) => ipcRenderer.invoke(IpcChannels.OPEN_EXTERNAL_CHANNEL, url),
  confirm: (message) => ipcRenderer.invoke(IpcChannels.CONFIRM_CHANNEL, message),
  pickFolder: (options) => ipcRenderer.invoke(IpcChannels.PICK_FOLDER_CHANNEL, options),
  showContextMenu: (items, position) =>
    ipcRenderer.invoke(IpcChannels.CONTEXT_MENU_CHANNEL, {
      items,
      ...(position === undefined ? {} : { position }),
    }),

  getUpdateState: () => ipcRenderer.invoke(IpcChannels.GET_UPDATE_STATE_CHANNEL),
  setUpdateChannel: (channel) =>
    ipcRenderer.invoke(IpcChannels.SET_UPDATE_CHANNEL_CHANNEL, channel),
  checkForUpdate: () => ipcRenderer.invoke(IpcChannels.CHECK_FOR_UPDATE_CHANNEL),
  downloadUpdate: () => ipcRenderer.invoke(IpcChannels.DOWNLOAD_UPDATE_CHANNEL),
  installUpdate: () => ipcRenderer.invoke(IpcChannels.INSTALL_UPDATE_CHANNEL),
  onUpdateState: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as Parameters<typeof listener>[0]);
    };
    ipcRenderer.on(IpcChannels.UPDATE_STATE_CHANNEL, wrapped);
    return () => {
      ipcRenderer.removeListener(IpcChannels.UPDATE_STATE_CHANNEL, wrapped);
    };
  },

  onMenuAction: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (typeof action !== "string") return;
      listener(action);
    };
    ipcRenderer.on(IpcChannels.MENU_ACTION_CHANNEL, wrapped);
    return () => {
      ipcRenderer.removeListener(IpcChannels.MENU_ACTION_CHANNEL, wrapped);
    };
  },
} satisfies DesktopBridge);
