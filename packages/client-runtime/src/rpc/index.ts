// Typed RPC surface over the supervised connection.
export {
  type RpcFailure,
  type RpcInput,
  type RpcStreamFailure,
  type RpcStreamValue,
  type RpcSuccess,
  type RpcTag,
  RpcUnavailableError,
  type StreamRpcTag,
  type UnaryRpcTag,
  request,
  subscribe,
} from "./client.ts";
export { makeWsRpcProtocolClient, type WsRpcProtocolClient } from "./protocol.ts";
export { type RpcSession, connect } from "./session.ts";
