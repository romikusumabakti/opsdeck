import { expect, test } from "@playwright/test";
import { AUTH_FILE } from "./support";

test.use({ storageState: AUTH_FILE });

// The saved session also carries the NEXT_LOCALE cookie of the last locale it
// visited (auth.spec.ts ends in /id), so each case states its own.
test("legacy unprefixed URLs redirect to the locale-prefixed page", async ({
  page,
  context,
}) => {
  await context.clearCookies({ name: "NEXT_LOCALE" });
  await page.goto("/servers");
  await expect(page).toHaveURL(/\/en\/servers$/);
});

test("an unprefixed URL lands in the NEXT_LOCALE cookie's locale", async ({
  page,
  context,
  baseURL,
}) => {
  await context.addCookies([
    { name: "NEXT_LOCALE", value: "id", url: baseURL ?? "" },
  ]);
  await page.goto("/servers");
  await expect(page).toHaveURL(/\/id\/servers$/);
});

test("the old /users URL redirects to the admin section", async ({ page }) => {
  await page.goto("/en/users");
  await expect(page).toHaveURL(/\/en\/admin\/users$/);
});

test("a production refresh on a deep link keeps the page", async ({ page }) => {
  await page.goto("/en/admin/users");
  const heading = page.getByRole("heading", { name: "User management" });
  await expect(heading).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/en\/admin\/users$/);
  await expect(heading).toBeVisible();
});

test("an unknown API path is a JSON 404", async ({ request }) => {
  const res = await request.get("/api/nope");
  expect(res.status()).toBe(404);
  expect(res.headers()["content-type"]).toContain("application/json");
});

test("pages carry the security headers", async ({ request }) => {
  const res = await request.get("/en/sign-in");
  expect(res.headers()["x-frame-options"]).toBe("DENY");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  expect(res.headers()["content-security-policy"]).toContain(
    "frame-ancestors 'none'"
  );
});
