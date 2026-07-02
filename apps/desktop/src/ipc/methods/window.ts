import {
  ContextMenuItemSchema,
  ContextMenuPosition,
  DesktopAppInfo,
  DesktopServerBootstrap,
  DesktopTheme,
  PickFolderOptions,
} from "@app/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopLocalEnvironmentAuth from "../../backend/DesktopLocalEnvironmentAuth.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronMenu from "../../electron/ElectronMenu.ts";
import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const ContextMenuInput = Schema.Struct({
  items: Schema.Array(ContextMenuItemSchema),
  position: Schema.optionalKey(ContextMenuPosition),
});

function toWebSocketBaseUrl(httpBaseUrl: URL): string {
  const url = new URL(httpBaseUrl.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

export const getAppInfo = DesktopIpc.makeSyncIpcMethod({
  channel: IpcChannels.GET_APP_INFO_CHANNEL,
  result: Schema.NullOr(DesktopAppInfo),
  handler: Effect.fn("desktop.ipc.window.getAppInfo")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return environment.appInfo;
  }),
});

export const getServerBootstrap = DesktopIpc.makeSyncIpcMethod({
  channel: IpcChannels.GET_SERVER_BOOTSTRAP_CHANNEL,
  result: Schema.NullOr(DesktopServerBootstrap),
  handler: Effect.fn("desktop.ipc.window.getServerBootstrap")(function* () {
    const manager = yield* DesktopBackendManager.DesktopBackendManager;
    const config = yield* manager.currentConfig;
    return Option.match(config, {
      onNone: () => null,
      onSome: (value) => ({
        httpBaseUrl: value.httpBaseUrl.href,
        wsBaseUrl: toWebSocketBaseUrl(value.httpBaseUrl),
      }),
    });
  }),
});

export const getBearerToken = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_BEARER_TOKEN_CHANNEL,
  payload: Schema.Void,
  result: Schema.String,
  handler: Effect.fn("desktop.ipc.window.getBearerToken")(function* () {
    const localAuth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
    return yield* localAuth.getBearerToken;
  }),
});

export const setTheme = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_THEME_CHANNEL,
  payload: DesktopTheme,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.window.setTheme")(function* (theme) {
    const electronTheme = yield* ElectronTheme.ElectronTheme;
    const settings = yield* DesktopAppSettings.DesktopAppSettings;
    yield* electronTheme.setSource(theme);
    yield* settings.setTheme(theme);
  }),
});

export const openExternal = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_EXTERNAL_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.window.openExternal")(function* (url) {
    const shell = yield* ElectronShell.ElectronShell;
    return yield* shell.openExternal(url);
  }),
});

export const confirm = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CONFIRM_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.window.confirm")(function* (message) {
    const dialog = yield* ElectronDialog.ElectronDialog;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const owner = yield* electronWindow.focusedMainOrFirst;
    return yield* dialog.confirm({ owner, message });
  }),
});

export const pickFolder = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PICK_FOLDER_CHANNEL,
  payload: Schema.UndefinedOr(PickFolderOptions),
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.window.pickFolder")(function* (options) {
    const dialog = yield* ElectronDialog.ElectronDialog;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const owner = yield* electronWindow.focusedMainOrFirst;
    const selected = yield* dialog.pickFolder({
      owner,
      defaultPath: Option.fromNullishOr(options?.defaultPath),
      title: Option.fromNullishOr(options?.title),
    });
    return Option.getOrNull(selected);
  }),
});

export const showContextMenu = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CONTEXT_MENU_CHANNEL,
  payload: ContextMenuInput,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.window.showContextMenu")(function* (input) {
    const electronMenu = yield* ElectronMenu.ElectronMenu;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const window = yield* electronWindow.focusedMainOrFirst;
    if (Option.isNone(window)) {
      return null;
    }
    const selected = yield* electronMenu.showContextMenu({
      window: window.value,
      items: input.items,
      position: Option.fromNullishOr(input.position),
    });
    return Option.getOrNull(selected);
  }),
});
