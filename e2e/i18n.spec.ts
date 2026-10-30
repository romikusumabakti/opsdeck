import { expect, test } from "@playwright/test";
import { AUTH_FILE } from "./support";

test.use({ storageState: AUTH_FILE });

test("switching to Arabic flips the document to rtl in the Arabic font, and back", async ({
  page,
}) => {
  await page.goto("/en");
  const html = page.locator("html");
  const body = page.locator("body");
  // web/styles.css sets Plex Sans Arabic on the body under [dir="rtl"].
  const arabicFont = /IBM Plex Sans Arabic/;
  await expect(html).toHaveAttribute("dir", "ltr");
  await expect(body).not.toHaveCSS("font-family", arabicFont);

  await page.getByRole("button", { name: "User menu" }).first().click();
  await page.getByRole("menuitem", { name: /Language/ }).click();
  await page.getByRole("menuitemradio", { name: "العربية" }).click();

  await expect(page).toHaveURL(/\/ar(\/|$)/);
  await expect(html).toHaveAttribute("dir", "rtl");
  await expect(html).toHaveAttribute("lang", "ar");
  await expect(body).toHaveCSS("font-family", arabicFont);

  // The switch is remembered (NEXT_LOCALE): a URL without a locale lands in it.
  await page.goto("/servers");
  await expect(page).toHaveURL(/\/ar\/servers$/);

  await page.getByRole("button", { name: "قائمة المستخدم" }).first().click();
  await page.getByRole("menuitem", { name: /اللغة/ }).click();
  await page.getByRole("menuitemradio", { name: "English" }).click();

  await expect(page).toHaveURL(/\/en(\/|$)/);
  await expect(html).toHaveAttribute("dir", "ltr");
  await expect(html).toHaveAttribute("lang", "en");
  await expect(body).not.toHaveCSS("font-family", arabicFont);
});
