import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  Note,
  NoteCreateInput,
  NoteDeleteInput,
  NoteNotFoundError,
  NotesStreamEvent,
  NoteUpdateInput,
} from "./notes.ts";
import {
  EchoInput,
  EchoResult,
  ServerConfig,
  ServerLifecycleStreamEvent,
  TickEvent,
} from "./server.ts";

/**
 * String method names for every WS RPC — the single source of truth the
 * server registers handlers against and the client calls by tag.
 */
export const WS_METHODS = {
  serverGetConfig: "server.getConfig",
  serverEcho: "server.echo",
  serverSubscribeTicks: "server.subscribeTicks",
  serverSubscribeLifecycle: "server.subscribeLifecycle",
  notesCreate: "notes.create",
  notesUpdate: "notes.update",
  notesDelete: "notes.delete",
  notesSubscribe: "notes.subscribe",
} as const;

// ── Unary RPCs ──────────────────────────────────────────────────────────────

/** No payload; the first call after connect also serves as initial sync. */
export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: EnvironmentAuthorizationError,
});

/** Round-trips input → output. The template for a request/response method. */
export const WsServerEchoRpc = Rpc.make(WS_METHODS.serverEcho, {
  payload: EchoInput,
  success: EchoResult,
  error: EnvironmentAuthorizationError,
});

// ── Streaming RPCs (server → client push) ────────────────────────────────────

/** A monotonic counter. The template for a live server-push stream. */
export const WsServerSubscribeTicksRpc = Rpc.make(WS_METHODS.serverSubscribeTicks, {
  payload: Schema.Struct({}),
  success: TickEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

/** Retained-snapshot + live lifecycle events (the ordered push-bus pattern). */
export const WsServerSubscribeLifecycleRpc = Rpc.make(WS_METHODS.serverSubscribeLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

// ── Notes RPCs (the sample domain — remove alongside notes.ts when forking) ──

export const WsNotesCreateRpc = Rpc.make(WS_METHODS.notesCreate, {
  payload: NoteCreateInput,
  success: Note,
  error: EnvironmentAuthorizationError,
});

export const WsNotesUpdateRpc = Rpc.make(WS_METHODS.notesUpdate, {
  payload: NoteUpdateInput,
  success: Note,
  error: Schema.Union([NoteNotFoundError, EnvironmentAuthorizationError]),
});

export const WsNotesDeleteRpc = Rpc.make(WS_METHODS.notesDelete, {
  payload: NoteDeleteInput,
  error: Schema.Union([NoteNotFoundError, EnvironmentAuthorizationError]),
});

/** Snapshot-then-live push bus for the notes list (same contract as lifecycle). */
export const WsNotesSubscribeRpc = Rpc.make(WS_METHODS.notesSubscribe, {
  payload: Schema.Struct({}),
  success: NotesStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

/** The wire contract the server decodes against and the client is typed by. */
export const WsRpcGroup = RpcGroup.make(
  WsServerGetConfigRpc,
  WsServerEchoRpc,
  WsServerSubscribeTicksRpc,
  WsServerSubscribeLifecycleRpc,
  WsNotesCreateRpc,
  WsNotesUpdateRpc,
  WsNotesDeleteRpc,
  WsNotesSubscribeRpc,
);
