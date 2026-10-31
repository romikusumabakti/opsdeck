import { expect, test } from "@playwright/test";
import { AUTH_FILE } from "./support";

test.use({ storageState: AUTH_FILE });

// Icon buttons carry a tooltip; it must not break the menu the button opens.
test("icon-button menus still open, show their icon and a tooltip", async ({
  page,
}) => {
  await page.goto("/en");

  const bell = page.getByRole("button", { name: "Notifications" });
  await expect(bell.locator("svg").first()).toBeVisible();
  await bell.hover();
  await expect(
    page.locator("[data-slot=tooltip-content]", { hasText: "Notifications" })
  ).toBeVisible();
  await bell.click();
  await expect(bell).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(bell).toHaveAttribute("aria-expanded", "false");

  const user = page.getByRole("button", { name: "User menu" }).first();
  await user.click();
  await expect(page.getByRole("menuitem", { name: /Language/ })).toBeVisible();
  await page.keyboard.press("Escape");
});
