import { AVAILABLE_CONNECTION_STATE } from "@app/client-runtime/connection";
import { expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { ConnectionStatus } from "~/components/ConnectionStatus";
import { render } from "../support/render";

it("offers a retry while the connection is blocked", async () => {
  const onRetry = vi.fn();

  await using screen = await render(
    <ConnectionStatus
      state={{ ...AVAILABLE_CONNECTION_STATE, phase: "blocked" }}
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
