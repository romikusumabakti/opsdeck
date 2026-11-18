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

test.beforeAll(async ({ browser, baseURL }) => {
  stub = await startAssistantStub();
  // The project is made here, not by a test, so no test depends on another
  // (or breaks on a CI retry). An existing one is fine.
  const context = await browser.newContext({
    baseURL,
    storageState: AUTH_FILE,
  });
  try {
    const projects = await context.request.get(
      "/api/project-catalog/list-projects"
    );
    const known = projects.ok() && (await projects.text()).includes(KEY);
    if (!known) {
      const created = await context.request.post(
        "/api/project-catalog/add-project",
        { data: { data: { name: PROJECT_NAME, key: KEY } } }
      );
      expect(created.ok()).toBe(true);
    }
  } finally {
    await context.close();
  }
});

test.afterAll(async () => {
  await stub.close();
});

test.beforeEach(async ({ page }) => {
  // Settings are instance-wide.
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

// A mention in the middle of the text pins its project as the question's
// context: the sent request carries it, wherever the @word sat.
for (const how of ["click", "Enter"] as const) {
  test(`picking a mention mid-sentence by ${how} sends that project as the context`, async ({
    page,
  }) => {
    await page.goto("/en/assistant");
    const box = page.getByPlaceholder(ASK);
    await box.fill(`ringkas @${KEY}`);
    const option = page.getByRole("option", { name: PROJECT_NAME });
    await expect(option).toBeVisible();
    if (how === "click") await option.click();
    else await box.press("Enter");
    await box.pressSequentially(" singkat");
    // The pick adds its own trailing space, so the typed one makes two.
    await expect(box).toHaveValue(`ringkas @${PROJECT_NAME}  singkat`);

    const sent = page.waitForRequest(
      (r) =>
        r.method() === "POST" && r.url().endsWith("/api/assistant/send-message")
    );
    await page.getByRole("button", { name: "Send" }).click();
    const body = (await sent).postDataJSON() as {
      context: { kind: string; projectId?: string };
    };
    expect(body.context.kind).toBe("project");
    const list = await page.request.get("/api/project-catalog/list-projects");
    const projects = (await list.json()) as { id: string; key: string }[];
    const projectId = projects.find((p) => p.key === KEY)?.id;
    expect(projectId).toBeDefined();
    expect(body.context.projectId).toBe(projectId);
    await expect(page.getByText("lives in the auth module.")).toBeVisible({
      timeout: 30_000,
    });
  });
}

test("switching chats keeps each chat's unsent text and context", async ({
  page,
}) => {
  await page.goto("/en/assistant");
  // A chat of its own, so the test doesn't lean on the others.
  // Unique per run: the title is how the chat is found again, and a retry or
  // a reused database holds earlier runs' chats.
  const title = `Seed the switch chat ${Date.now()}`;
  await page.getByPlaceholder(ASK).fill(title);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("lives in the auth module.")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Copy answer" })).toBeVisible();

  const box = page.getByPlaceholder(ASK);
  await box.fill(`draft @${KEY}`);
  await page.getByRole("option", { name: PROJECT_NAME }).click();
  await box.pressSequentially("kept");
  const text = await box.inputValue();
  const chip = page.getByRole("combobox", { name: /^Context: / });
  const chipName = await chip.getAttribute("aria-label");
  expect(chipName).toContain(PROJECT_NAME);

  await page.getByRole("button", { name: "New chat" }).click();
  await expect(box).toHaveValue("");
  await expect(chip).toHaveAttribute("aria-label", "Context: Automatic");

  await page
    .getByRole("navigation", { name: "Chats" })
    .getByText(title)
    .click();
  await expect(box).toHaveValue(text);
  await expect(chip).toHaveAttribute("aria-label", chipName as string);
});
