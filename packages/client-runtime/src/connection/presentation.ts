import type { SupervisorConnectionState } from "./model.ts";

export type ConnectionPhase =
  | "available"
  | "offline"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "error"
  | "unauthenticated";

export interface ConnectionPresentation {
  readonly phase: ConnectionPhase;
  readonly error: string | null;
}

export function presentConnectionState(state: SupervisorConnectionState): ConnectionPresentation {
  switch (state.phase) {
    case "available":
      return { phase: "available", error: null };
    case "offline":
      return { phase: "offline", error: null };
    case "connecting":
      return {
        phase: state.attempt <= 1 && state.lastFailure === null ? "connecting" : "reconnecting",
        error: state.lastFailure?.message ?? null,
      };
    case "connected":
      return { phase: "connected", error: null };
    case "backoff":
      return { phase: "reconnecting", error: state.lastFailure?.message ?? null };
    case "blocked":
      return {
        phase: state.lastFailure?.reason === "authentication" ? "unauthenticated" : "error",
        error: state.lastFailure?.message ?? null,
      };
  }
}

export function connectionStatusText(connection: ConnectionPresentation): string {
  switch (connection.phase) {
    case "available":
      return "Available";
    case "offline":
      return "Offline";
    case "connecting":
      return "Connecting...";
    case "reconnecting":
      return connection.error
        ? `Failed to connect. Reconnecting... Reason: ${connection.error}`
        : "Reconnecting...";
    case "connected":
      return "Connected";
    case "unauthenticated":
      return connection.error
        ? `Sign-in required. Reason: ${connection.error}`
        : "Sign-in required";
    case "error":
      return connection.error
        ? `Connection failed. Reason: ${connection.error}`
        : "Connection failed";
  }
}

export function connectionStatusTitle(connection: ConnectionPresentation): string {
  if (connection.phase === "reconnecting" && connection.error) {
    return "Failed to connect. Reconnecting...";
  }

  return connectionStatusText({ ...connection, error: null });
}
