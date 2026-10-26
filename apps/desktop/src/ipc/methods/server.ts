import { DesktopServerBootstrap } from "@app/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopBackend from "../../backend/DesktopBackend.ts";
import * as DesktopServerAuth from "../../backend/DesktopServerAuth.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

// Synchronous so the renderer knows its server before any module that connects has loaded.
export const getServerBootstrap = DesktopIpc.makeSyncIpcMethod({
  channel: IpcChannels.GET_SERVER_BOOTSTRAP_CHANNEL,
  result: Schema.NullOr(DesktopServerBootstrap),
  handler: Effect.fn("desktop.ipc.getServerBootstrap")(function* () {
    const backend = yield* DesktopBackend.DesktopBackend;

    return yield* backend.rendererBootstrap;
  }),
});

export const getBearerToken = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_BEARER_TOKEN_CHANNEL,
  payload: Schema.Void,
  result: Schema.String,
  handler: Effect.fn("desktop.ipc.getBearerToken")(function* () {
    const auth = yield* DesktopServerAuth.DesktopServerAuth;

    return yield* auth.getBearerToken;
  }),
});
