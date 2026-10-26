import { describe, expect, it } from "@effect/vitest";

import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type SupervisorConnectionState,
} from "../../src/connection/model.ts";
import { connectionStatusText, presentConnectionState } from "../../src/connection/presentation.ts";

function supervisorState(overrides: Partial<SupervisorConnectionState>): SupervisorConnectionState {
  return {
    desired: true,
    network: "online",
    phase: "connecting",
    attempt: 1,
    generation: 0,
    lastFailure: null,
    retryAt: null,
    ...overrides,
  };
}

describe("connection presentation", () => {
  it("distinguishes initial connection, reconnect, and retry errors", () => {
    expect(presentConnectionState(supervisorState({ phase: "connecting", attempt: 1 }))).toEqual({
      phase: "connecting",
      error: null,
    });
    expect(
      presentConnectionState(
        supervisorState({
          phase: "connecting",
          attempt: 2,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Socket closed.",
          }),
        }),
      ),
    ).toEqual({ phase: "reconnecting", error: "Socket closed." });
    expect(
      presentConnectionState(
        supervisorState({
          phase: "backoff",
          attempt: 2,
          retryAt: 1,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Disconnected.",
          }),
        }),
      ),
    ).toEqual({ phase: "reconnecting", error: "Disconnected." });
  });

  it("preserves an explicitly available connection while offline", () => {
    expect(
      presentConnectionState(
        supervisorState({ desired: false, network: "offline", phase: "available", attempt: 0 }),
      ),
    ).toEqual({ phase: "available", error: null });
  });

  it("distinguishes a rejected credential from a configuration block", () => {
    const authentication = presentConnectionState(
      supervisorState({
        phase: "blocked",
        lastFailure: new ConnectionBlockedError({
          reason: "authentication",
          detail: "The local server did not accept this client's credentials.",
        }),
      }),
    );

    const configuration = presentConnectionState(
      supervisorState({
        phase: "blocked",
        lastFailure: new ConnectionBlockedError({
          reason: "configuration",
          detail: "The server URL is not valid.",
        }),
      }),
    );

    expect(connectionStatusText(authentication)).toBe(
      "Sign-in required. Reason: The local server did not accept this client's credentials.",
    );
    expect(connectionStatusText(configuration)).toBe(
      "Connection failed. Reason: The server URL is not valid.",
    );
  });
});
