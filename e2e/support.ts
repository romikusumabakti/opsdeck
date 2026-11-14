import { readFileSync } from "node:fs";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import type { Page } from "@playwright/test";

export const ADMIN = {
  name: "E2E Admin",
  email: "admin@example.com",
  password: "e2e-Password-123",
};

/** Where auth.spec.ts leaves the signed-in admin's cookies for the other specs. */
export const AUTH_FILE = "e2e/.auth/admin.json";

/** The admin's authenticator secret, saved by auth.spec.ts when it turns TOTP on. */
export const TOTP_SECRET_FILE = "e2e/.auth/totp-secret";

/**
 * The code an authenticator app would show right now for the admin. The saved
 * secret is the Base32 text from the setup screen; an authenticator decodes it
 * to bytes before computing the code, so this does too.
 */
export async function totpCode() {
  const secret = readFileSync(TOTP_SECRET_FILE, "utf8").trim();
  return createOTP(base32.decode(secret)).totp();
}

/** First step of sign-in: email and password. Labels differ per locale, so address the inputs by type. */
export async function submitCredentials(page: Page, submitName: string) {
  await page.locator('input[type="email"]').fill(ADMIN.email);
  await page.locator('input[type="password"]').fill(ADMIN.password);
  await page.getByRole("button", { name: submitName, exact: true }).click();
}

// better-auth's two-factor plugin allows 3 verifications per client, and the
// counter only resets after 10 quiet seconds since the last one. The specs run
// from one address, so rather than loosen that limit the helpers below pace
// their own verifications.
const VERIFY_LIMIT = 3;
const VERIFY_WINDOW_MS = 10_500;
let verifyCount = 0;
let lastVerifyAt = 0;

/** Call right before a TOTP verification; waits if the rate limit would reject it. */
export async function paceTotpVerification() {
  if (Date.now() - lastVerifyAt >= VERIFY_WINDOW_MS) verifyCount = 0;
  if (verifyCount >= VERIFY_LIMIT) {
    const wait = lastVerifyAt + VERIFY_WINDOW_MS - Date.now();
    await new Promise((resolve) => setTimeout(resolve, wait));
    verifyCount = 0;
  }
  verifyCount += 1;
  lastVerifyAt = Date.now();
}

/** Second step of sign-in: the code field is the only one-time-code input on the page. */
export async function submitCode(page: Page, code: string) {
  await paceTotpVerification();
  const field = page.locator('input[autocomplete="one-time-code"]');
  await field.fill(code);
  await field.press("Enter");
}

/** Sign in through the form, including the authenticator code step. */
export async function signIn(page: Page, submitName: string) {
  await submitCredentials(page, submitName);
  await submitCode(page, await totpCode());
}
