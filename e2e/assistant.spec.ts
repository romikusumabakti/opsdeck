import { expect, test } from "@playwright/test";
import { type AssistantStub, startAssistantStub } from "./assistant-stub";
import { AUTH_FILE } from "./support";

test.use({ storageState: AUTH_FILE });

// The assistant runs against a local stub of an OpenAI-compatible
// chat-completions API (e2e/assistant-stub.ts), started here on a free port.
// Never point it at a real provider: it costs money.
let stub: AssistantStub;
const KEY = "EASST";
const PROJECT_NAME = `E2E Assistant ${KEY}`;

test.beforeAll(async () => {
  stub = await startAssistantStub();
});

test.afterAll(async () => {
  await stub.close();
});

test.beforeEach(async ({ page }) => {
  // Settings are instance-wide; the project is created once.
  const saved = await page.request.put("/api/assistant-settings", {
    data: {
      enabled: true,
      provider: "openai-compatible",
      baseUrl: stub.baseUrl,
      // A placeholder, the stub ignores it.
      apiKey: "e2e-stub-key",
      model: "stub-model",
      prices: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      dailyCapUsd: 5,
    },
  });
  expect(((await saved.json()) as { success: boolean }).success).toBe(true);
});

const ASK = "Ask anything — type @ to pick a project";

test("an admin enables the assistant and gets a streamed answer", async ({
  page,
}) => {
  const project = await page.request.post("/api/project-catalog/add-project", {
    data: { data: { name: PROJECT_NAME, key: KEY } },
  });
  expect(project.ok()).toBe(true);

  await page.goto("/en/assistant");
  await page.getByPlaceholder(ASK).fill("Where is login?");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText("lives in the auth module.")).toBeVisible({
    timeout: 30_000,
  });
  // Shown under an answer once it has finished streaming.
  await expect(page.getByRole("button", { name: "Copy answer" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("the composer is one group holding attach, context and send", async ({
  page,
}) => {
  await page.goto("/en/assistant");
  const group = page.locator("[data-slot=input-group]");
  await expect(group).toHaveCount(1);
  await expect(group.locator("textarea")).toBeVisible();
  await expect(group.getByRole("button", { name: "Attach" })).toBeVisible();
  await expect(group.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(group).toContainText("Automatic");
});

test("typing @ in the middle of the text opens the mention list", async ({
  page,
}) => {
  await page.goto("/en/assistant");
  const box = page.getByPlaceholder(ASK);
  await box.fill("Where is login in @E2E");
  await expect(
    page.getByRole("listbox", { name: "Projects and environments" })
  ).toBeVisible();
  await expect(page.getByRole("option", { name: PROJECT_NAME })).toBeVisible();
});

test("Stop ends a slow answer with a Stopped note, and Retry answers again", async ({
  page,
}) => {
  await page.goto("/en/assistant");
  await page.getByPlaceholder(ASK).fill("Explain the slow path");
  await page.getByRole("button", { name: "Send" }).click();

  // Streaming has begun: some of the slow text is on screen.
  await expect(page.getByText("word0")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Stop" }).click();

  await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();

  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("lives in the auth module.")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Stopped", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy answer" })).toBeVisible();
});
