import { expect, test } from "@playwright/test";
import { AUTH_FILE } from "./support";

test.use({ storageState: AUTH_FILE });

// Runs only against a local stub of an OpenAI-compatible chat-completions
// API: set ASSISTANT_E2E_BASE_URL to the stub's base URL (e.g.
// http://127.0.0.1:8787/v1). The stub must stream one text answer (it may
// call a tool first). The project has no code sources, so the answer has no
// "Sources" list. Never run it against a real provider: it costs money.
const STUB_BASE_URL = process.env.ASSISTANT_E2E_BASE_URL;
test.skip(
  !STUB_BASE_URL,
  "needs a local OpenAI-compatible stub (set ASSISTANT_E2E_BASE_URL)"
);

test("an admin enables the assistant and gets a streamed answer", async ({
  page,
}) => {
  const key = "EASST";
  const project = await page.request.post("/api/project-catalog/add-project", {
    data: { data: { name: `E2E Assistant ${key}`, key } },
  });
  expect(project.ok()).toBe(true);

  // Settings: the key is a placeholder, the stub ignores it.
  const saved = await page.request.put("/api/assistant-settings", {
    data: {
      enabled: true,
      provider: "openai-compatible",
      baseUrl: STUB_BASE_URL,
      apiKey: "e2e-stub-key",
      model: "stub-model",
      prices: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      dailyCapUsd: 5,
    },
  });
  expect(((await saved.json()) as { success: boolean }).success).toBe(true);

  await page.goto("/en/assistant");

  await page
    .getByPlaceholder("Ask anything — type @ to pick a project")
    .fill("Where is login?");
  await page.getByRole("button", { name: "Send" }).click();

  // Shown under an answer once it has finished streaming.
  await expect(page.getByRole("button", { name: "Copy answer" })).toBeVisible({
    timeout: 30_000,
  });
});
