import { WsRpcGroup } from "@app/contracts";
import type * as Effect from "effect/Effect";
import * as RpcClient from "effect/rpc/RpcClient";

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup);

export type WsRpcProtocolClient = Effect.Success<typeof makeWsRpcProtocolClient>;

// Pings go out every 5 seconds, and a server busy for a few seconds stops
// answering them. Allow 15 seconds without any frame before dropping the socket.
export const PING_TIMEOUT = "15 seconds";
