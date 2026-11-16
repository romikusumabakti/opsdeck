import { expect, test } from "@playwright/test";
import { AUTH_FILE } from "./support";

test.use({ storageState: AUTH_FILE });

// Runs only against a local stub of the Anthropic Messages API: set
// ANTHROPIC_E2E=1 and point ANTHROPIC_BASE_URL (read by the SDK, inherited by
// the web server Playwright starts) at the stub, which must stream one answer
// that cites a source. Never run it against the real API: it costs money.
test.skip(
  !process.env.ANTHROPIC_E2E,
  "needs a local Anthropic API stub (set ANTHROPIC_E2E and ANTHROPIC_BASE_URL)"
);

test("an admin enables the assistant and gets a streamed answer with sources", async ({
  page,
}) => {
  const key = "EASST";
  const project = await page.request.post("/api/project-catalog/add-project", {
    data: { data: { name: `E2E Assistant ${key}`, key } },
  });
  expect(project.ok()).toBe(true);

  // Settings: the key is a placeholder, the stub ignores it.
  const saved = await page.request.put("/api/assistant-settings", {
    data: { enabled: true, apiKey: "sk-ant-e2e-stub", dailyCapUsd: 5 },
  });
  expect(((await saved.json()) as { success: boolean }).success).toBe(true);

  await page.goto("/en/projects");
  await page
    .getByRole("link", { name: `E2E Assistant ${key}` })
    .first()
    .click();
  await page.getByRole("link", { name: "Assistant" }).first().click();

  await page.getByPlaceholder("Write a question…").fill("Where is login?");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText("Sources", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
});
