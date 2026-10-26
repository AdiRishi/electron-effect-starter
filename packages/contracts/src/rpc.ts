import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  Note,
  NoteCreateInput,
  NoteDeleteInput,
  NoteNotFoundError,
  NotesStorageError,
  NotesStreamEvent,
  NoteUpdateInput,
} from "./notes.ts";
import { ServerLifecycleEvent } from "./server.ts";

export const WS_PATH = "/ws";

export const WS_METHODS = {
  serverProbe: "server.probe",
  subscribeServerLifecycle: "server.subscribeLifecycle",
  notesCreate: "notes.create",
  notesUpdate: "notes.update",
  notesDelete: "notes.delete",
  subscribeNotes: "notes.subscribe",
} as const;

/** Answers immediately; the connection supervisor uses it to check a socket is alive. */
const WsServerProbeRpc = Rpc.make(WS_METHODS.serverProbe, {
  payload: Schema.Struct({}),
  success: Schema.Struct({}),
});

const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleEvent,
  stream: true,
});

const WsNotesCreateRpc = Rpc.make(WS_METHODS.notesCreate, {
  payload: NoteCreateInput,
  success: Note,
  error: NotesStorageError,
});

const WsNotesUpdateRpc = Rpc.make(WS_METHODS.notesUpdate, {
  payload: NoteUpdateInput,
  success: Note,
  error: Schema.Union([NoteNotFoundError, NotesStorageError]),
});

const WsNotesDeleteRpc = Rpc.make(WS_METHODS.notesDelete, {
  payload: NoteDeleteInput,
  success: Schema.Struct({}),
  error: Schema.Union([NoteNotFoundError, NotesStorageError]),
});

const WsSubscribeNotesRpc = Rpc.make(WS_METHODS.subscribeNotes, {
  payload: Schema.Struct({}),
  success: NotesStreamEvent,
  error: NotesStorageError,
  stream: true,
});

export const WsRpcGroup = RpcGroup.make(
  WsServerProbeRpc,
  WsSubscribeServerLifecycleRpc,
  WsNotesCreateRpc,
  WsNotesUpdateRpc,
  WsNotesDeleteRpc,
  WsSubscribeNotesRpc,
);
export type WsRpcMethod = (typeof WS_METHODS)[keyof typeof WS_METHODS];
