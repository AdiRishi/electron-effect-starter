import type * as Effect from "effect/Effect";
import * as RpcClient from "effect/unstable/rpc/RpcClient";

import { WsRpcGroup } from "@app/contracts";

/**
 * The factory that materializes a typed client for every method in `WsRpcGroup`.
 * Building it requires an `RpcClient.Protocol` in context (wired in `session.ts`).
 */
export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup);

type RpcClientFactory = typeof makeWsRpcProtocolClient;

/**
 * The typed RPC client surface. Unary methods return `Effect`s; `stream: true`
 * methods (`subscribeTicks`, `subscribeServerLifecycle`) return `Stream`s. The
 * method tags come straight from `WS_METHODS`.
 */
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, unknown, unknown> ? Client : never;
