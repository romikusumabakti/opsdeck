import type { Page } from "@playwright/test";

export const ADMIN = {
  name: "E2E Admin",
  email: "admin@example.com",
  password: "e2e-Password-123",
};

/** Where auth.spec.ts leaves the signed-in admin's cookies for the other specs. */
export const AUTH_FILE = "e2e/.auth/admin.json";

/** Sign in through the form. Labels differ per locale, so address the inputs by type. */
export async function signIn(page: Page, submitName: string) {
  await page.locator('input[type="email"]').fill(ADMIN.email);
  await page.locator('input[type="password"]').fill(ADMIN.password);
  await page.getByRole("button", { name: submitName, exact: true }).click();
}
