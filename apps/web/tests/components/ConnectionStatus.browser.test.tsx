import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionBlockedError,
  ConnectionTransientError,
} from "@app/client-runtime/connection";
import { expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { ConnectionStatus } from "~/components/ConnectionStatus";
import { render } from "../support/render";

const rejectedCredential = new ConnectionBlockedError({
  reason: "authentication",
  detail: "The local server did not accept this client's credentials.",
});

it("offers a retry while the connection is blocked", async () => {
  const onRetry = vi.fn();

  await using screen = await render(
    <ConnectionStatus
      state={{ ...AVAILABLE_CONNECTION_STATE, phase: "blocked", lastFailure: rejectedCredential }}
      onRetry={onRetry}
    />,
    { router: false },
  );

  await expect.element(screen.getByText("Sign-in required")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Retry now" }));
  expect(onRetry).toHaveBeenCalledOnce();
});

it("offers no retry once connected", async () => {
  await using screen = await render(
    <ConnectionStatus
      state={{ ...AVAILABLE_CONNECTION_STATE, phase: "connected" }}
      onRetry={() => {}}
    />,
    { router: false },
  );

  await expect.element(screen.getByText("Connected")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Retry now" })).not.toBeInTheDocument();
});

it("shows why a reconnect is pending in the status dot's tooltip", async () => {
  const reason = "The local server disconnected.";

  await using screen = await render(
    <ConnectionStatus
      state={{
        ...AVAILABLE_CONNECTION_STATE,
        phase: "backoff",
        attempt: 2,
        lastFailure: new ConnectionTransientError({ reason: "transport", detail: reason }),
      }}
      onRetry={() => {}}
    />,
    { router: false },
  );

  await expect.element(screen.getByText("Failed to connect. Reconnecting...")).toBeVisible();
  await userEvent.hover(
    screen.getByRole("button", { name: `Failed to connect. Reconnecting... Reason: ${reason}` }),
  );
  await expect
    .element(page.getByText(`Failed to connect. Reconnecting... Reason: ${reason}`))
    .toBeVisible();
});
