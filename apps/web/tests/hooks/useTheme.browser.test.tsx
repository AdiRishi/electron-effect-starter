import { expect, it } from "vitest";
import { commands } from "vitest/browser";

import { useTheme } from "~/hooks/useTheme";
import { render } from "../support/render";

function Appearance() {
  const { resolvedTheme } = useTheme();

  return <p>Appearance: {resolvedTheme}</p>;
}

it("follows the operating system between light and dark while mounted", async () => {
  await commands.emulateColorScheme("light");

  await using screen = await render(<Appearance />, { router: false });

  await expect.element(screen.getByText("Appearance: light")).toBeVisible();
  expect(document.documentElement.classList.contains("dark")).toBe(false);

  await commands.emulateColorScheme("dark");

  await expect.element(screen.getByText("Appearance: dark")).toBeVisible();
  expect(document.documentElement.classList.contains("dark")).toBe(true);

  await commands.emulateColorScheme("light");

  await expect.element(screen.getByText("Appearance: light")).toBeVisible();
  expect(document.documentElement.classList.contains("dark")).toBe(false);
});
