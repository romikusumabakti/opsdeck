import { expect, test } from "@playwright/test";
import { AUTH_FILE } from "./support";

test.use({ storageState: AUTH_FILE });

test("switching to Arabic flips the document to rtl, and back to ltr", async ({
  page,
}) => {
  await page.goto("/en");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("dir", "ltr");

  await page.getByRole("button", { name: "User menu" }).first().click();
  await page.getByRole("menuitem", { name: /Language/ }).click();
  await page.getByRole("menuitemradio", { name: "العربية" }).click();

  await expect(page).toHaveURL(/\/ar(\/|$)/);
  await expect(html).toHaveAttribute("dir", "rtl");
  await expect(html).toHaveAttribute("lang", "ar");

  await page.getByRole("button", { name: "قائمة المستخدم" }).first().click();
  await page.getByRole("menuitem", { name: /اللغة/ }).click();
  await page.getByRole("menuitemradio", { name: "English" }).click();

  await expect(page).toHaveURL(/\/en(\/|$)/);
  await expect(html).toHaveAttribute("dir", "ltr");
  await expect(html).toHaveAttribute("lang", "en");
});
