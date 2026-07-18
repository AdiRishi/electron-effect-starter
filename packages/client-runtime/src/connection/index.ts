// Connection model + reconnect supervisor + platform seams.
export {
  ConnectionBlockedError,
  type ConnectionAttemptError,
  type ConnectionPhase,
  type ConnectionState,
  ConnectionTransientError,
  INITIAL_CONNECTION_STATE,
  type PreparedConnection,
} from "./model.ts";
export {
  Connectivity,
  type ConnectivityShape,
  ConnectionWakeups,
  type ConnectionWakeupsShape,
  type ConnectionWakeup,
  type NetworkStatus,
} from "./platform.ts";
export { ConnectionSupervisor, layer as connectionSupervisorLayer, start } from "./supervisor.ts";
