import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { EnvironmentAuthorizationError } from "./auth.ts";
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
  echo: "echo",
  subscribeTicks: "subscribeTicks",
  subscribeServerLifecycle: "subscribeServerLifecycle",
} as const;

// ── Unary RPCs ──────────────────────────────────────────────────────────────

/** No payload; the first call after connect also serves as initial sync. */
export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: EnvironmentAuthorizationError,
});

/** Round-trips input → output. The template for a request/response method. */
export const WsEchoRpc = Rpc.make(WS_METHODS.echo, {
  payload: EchoInput,
  success: EchoResult,
  error: EnvironmentAuthorizationError,
});

// ── Streaming RPCs (server → client push) ────────────────────────────────────

/** A monotonic counter. The template for a live server-push stream. */
export const WsSubscribeTicksRpc = Rpc.make(WS_METHODS.subscribeTicks, {
  payload: Schema.Struct({}),
  success: TickEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

/** Retained-snapshot + live lifecycle events (the ordered push-bus pattern). */
export const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

/** The wire contract the server decodes against and the client is typed by. */
export const WsRpcGroup = RpcGroup.make(
  WsServerGetConfigRpc,
  WsEchoRpc,
  WsSubscribeTicksRpc,
  WsSubscribeServerLifecycleRpc,
);
