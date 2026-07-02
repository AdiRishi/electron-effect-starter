import * as Effect from "effect/Effect";

import * as DesktopIpc from "./DesktopIpc.ts";
import {
  checkForUpdate,
  downloadUpdate,
  getUpdateState,
  installUpdate,
  setUpdateChannel,
} from "./methods/updates.ts";
import {
  confirm,
  getAppInfo,
  getBearerToken,
  getServerBootstrap,
  openExternal,
  pickFolder,
  setTheme,
  showContextMenu,
} from "./methods/window.ts";

// Registers every IPC handler in one place. Called once during bootstrap; each
// `handle`/`handleSync` is scoped, so the whole set is removed when the app
// scope closes.
export const installDesktopIpcHandlers = Effect.fn("desktop.ipc.installHandlers")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;

  yield* ipc.handleSync(getAppInfo);
  yield* ipc.handleSync(getServerBootstrap);
  yield* ipc.handle(getBearerToken);

  yield* ipc.handle(setTheme);
  yield* ipc.handle(openExternal);
  yield* ipc.handle(confirm);
  yield* ipc.handle(pickFolder);
  yield* ipc.handle(showContextMenu);

  yield* ipc.handle(getUpdateState);
  yield* ipc.handle(setUpdateChannel);
  yield* ipc.handle(checkForUpdate);
  yield* ipc.handle(downloadUpdate);
  yield* ipc.handle(installUpdate);
});
