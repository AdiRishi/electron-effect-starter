import { DesktopUpdateChannel, DesktopUpdateState } from "@app/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopUpdater from "../../updates/DesktopUpdater.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getUpdateState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_UPDATE_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateState,
  handler: Effect.fn("desktop.ipc.updates.getState")(function* () {
    const updater = yield* DesktopUpdater.DesktopUpdater;
    return yield* updater.getState;
  }),
});

export const setUpdateChannel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_UPDATE_CHANNEL_CHANNEL,
  payload: DesktopUpdateChannel,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.updates.setChannel")(function* (channel) {
    const updater = yield* DesktopUpdater.DesktopUpdater;
    yield* updater.setChannel(channel);
  }),
});

export const checkForUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CHECK_FOR_UPDATE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.updates.check")(function* () {
    const updater = yield* DesktopUpdater.DesktopUpdater;
    yield* updater.check;
  }),
});

export const downloadUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DOWNLOAD_UPDATE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.updates.download")(function* () {
    const updater = yield* DesktopUpdater.DesktopUpdater;
    yield* updater.download;
  }),
});

export const installUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.INSTALL_UPDATE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.updates.install")(function* () {
    const updater = yield* DesktopUpdater.DesktopUpdater;
    yield* updater.install;
  }),
});
