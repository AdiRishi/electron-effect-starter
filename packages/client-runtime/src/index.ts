// The shared client transport, platform-agnostic. The web app injects platform
// specifics (a WebSocket constructor, an HttpClient / fetch) at the edge.

// Bearer bootstrap (browser path of the auth handshake).
export {
  BearerBootstrapError,
  bootstrapRemoteBearerSession,
} from "./authorization.ts";

// Connection model + reconnect supervisor.
export {
  type ConnectionPhase,
  type ConnectionState,
  ConnectionTransientError,
  INITIAL_CONNECTION_STATE,
  type PreparedConnection,
} from "./connection/model.ts";
export { ConnectionSupervisor, layer as connectionSupervisorLayer, start } from "./connection/supervisor.ts";

// Typed RPC surface.
export {
  makeWsRpcProtocolClient,
  type WsRpcProtocolClient,
} from "./rpc/protocol.ts";
export { type RpcSession, connect } from "./rpc/session.ts";
export {
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
} from "./rpc/client.ts";
