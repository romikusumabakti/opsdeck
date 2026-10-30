import { expect, test } from "@playwright/test";
import { ADMIN, AUTH_FILE, signIn } from "./support";

// Serial: the first test creates the only account, the rest depend on it.
test.describe.configure({ mode: "serial" });

test("setup creates the first admin and lands on /en", async ({ page }) => {
  await page.goto("/en/setup");
  await page.getByLabel("Name", { exact: true }).fill(ADMIN.name);
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
  await page.getByLabel("Confirm password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Create account & sign in" }).click();

  await expect(page).toHaveURL(/\/en\/?$/);
});

test("a signed-out deep link round-trips through sign-in", async ({
  page,
  context,
}) => {
  await page.goto("/en/sign-in");
  await signIn(page, "Sign in");
  await expect(page).toHaveURL(/\/en\/?$/);

  await page.getByRole("button", { name: "User menu" }).first().click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/en\/sign-in/);

  await page.goto("/id/servers");
  await expect(page).toHaveURL("/id/sign-in?redirect=%2Fservers");

  await signIn(page, "Masuk");
  await expect(page).toHaveURL("/id/servers");

  // Signing out revoked the first session, so keep this one for the other
  // specs (which depend on this project).
  await context.storageState({ path: AUTH_FILE });
});

test("a forged session cookie is treated as signed out", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: "better-auth.session_token",
      value: "bogus",
      url: baseURL,
    },
  ]);
  const page = await context.newPage();
  await page.goto("/en/servers");
  await expect(page).toHaveURL(/\/en\/sign-in/);
  await context.close();
});
