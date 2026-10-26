import * as Effect from "effect/Effect";

import * as DesktopIpc from "./DesktopIpc.ts";
import * as ServerMethods from "./methods/server.ts";
import * as ShellMethods from "./methods/shell.ts";

/** Registers every renderer-facing IPC handler for the life of the enclosing scope. */
export const installDesktopIpcHandlers = Effect.fn("desktop.ipc.installHandlers")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  yield* ipc.handleSync(ServerMethods.getServerBootstrap);
  yield* ipc.handle(ServerMethods.getBearerToken);
  yield* ipc.handle(ShellMethods.openExternal);
});
