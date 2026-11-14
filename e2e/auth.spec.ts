import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect, test } from "@playwright/test";
import {
  ADMIN,
  AUTH_FILE,
  paceTotpVerification,
  signIn,
  submitCode,
  submitCredentials,
  TOTP_SECRET_FILE,
  totpCode,
} from "./support";

// Serial: the first test creates the only account, the rest depend on it.
test.describe.configure({ mode: "serial" });

test("setup creates the first admin, turns on an authenticator and lands on /en", async ({
  page,
}) => {
  await page.goto("/en/setup");
  await page.getByLabel("Name", { exact: true }).fill(ADMIN.name);
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
  await page.getByLabel("Confirm password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Create account & sign in" }).click();

  await expect(page).toHaveURL(/\/en\/?$/);

  // Strong sign-in is required for admin areas, so every later spec needs an
  // admin who signs in with password and code: turn on an authenticator app
  // and keep its secret for the sign-in helper.
  await page.goto("/en/account?tab=security");
  await page.getByRole("button", { name: "Turn on" }).click();
  await page.getByLabel("Confirm your password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Continue" }).click();

  const secret = (await page.getByTestId("totp-secret").textContent())?.trim();
  expect(secret).toBeTruthy();
  mkdirSync(dirname(TOTP_SECRET_FILE), { recursive: true });
  writeFileSync(TOTP_SECRET_FILE, `${secret}\n`);

  await paceTotpVerification();
  await page.getByLabel("Authentication code").fill(await totpCode());
  await page.getByRole("button", { name: "Verify and turn on" }).click();

  await expect(page.getByTestId("backup-codes")).toBeVisible();
  await page.getByRole("button", { name: "I've saved them" }).click();
  await expect(page.getByRole("button", { name: "Turn off" })).toBeVisible();
});

test("a wrong authenticator code shows an error and does not sign in", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto("/en/sign-in");
  await submitCredentials(page, "Sign in");

  const valid = await totpCode();
  await submitCode(page, valid === "000000" ? "000001" : "000000");

  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(/\/en\/sign-in/);
  await context.close();
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
