// Connection model + reconnect supervisor.
export {
  type ConnectionPhase,
  type ConnectionState,
  ConnectionTransientError,
  INITIAL_CONNECTION_STATE,
  type PreparedConnection,
} from "./model.ts";
export { ConnectionSupervisor, layer as connectionSupervisorLayer, start } from "./supervisor.ts";
