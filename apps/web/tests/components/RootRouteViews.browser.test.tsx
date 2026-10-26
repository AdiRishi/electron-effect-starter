import { expect, it } from "vitest";

import { RootRouteErrorView, RootRouteNotFoundView } from "~/components/RootRouteViews";
import { render } from "../support/render";

it("reports the failing page's path without its query or fragment", async () => {
  const error = new Error("Notes failed to render", { cause: new Error("storage is locked") });

  await using screen = await render(<RootRouteErrorView error={error} reset={() => {}} />, {
    router: "/notes/42?token=secret#token=secret",
  });

  await expect.element(screen.getByText("Notes failed to render", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Reload app" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Copy error" })).toBeVisible();

  const report = screen.container.querySelector("pre")?.textContent ?? "";

  expect(report).toContain("Path: /notes/42\n");
  expect(report).toContain("Caused by:\nError: storage is locked");
  expect(report).not.toContain("secret");
});

it("sends an unknown path home", async () => {
  await using screen = await render(<RootRouteNotFoundView />, { router: "/no-such-page" });

  await expect.element(screen.getByText("Page not found")).toBeVisible();
  await expect.element(screen.getByRole("link", { name: "Go home" })).toHaveAttribute("href", "/");
});
