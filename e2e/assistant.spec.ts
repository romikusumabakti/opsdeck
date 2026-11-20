import { expect, test } from "@playwright/test";
import {
  type AssistantStub,
  NAMED_TITLE,
  startAssistantStub,
} from "./assistant-stub";
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
  // The composer's group (the chat list's search field is one too).
  const group = page
    .locator("[data-slot=input-group]")
    .filter({ has: page.locator("textarea") });
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

test("a tool turn streams its preamble, shows the tool step, then the answer collapsed", async ({
  page,
}) => {
  await page.goto("/en/assistant");
  await page.getByPlaceholder(ASK).fill("please use a tool");
  await page.getByRole("button", { name: "Send" }).click();

  // The stub holds the final text back, so the interim step is observable:
  // its muted text and the tool's chip (toolLabels.list_issues).
  await expect(
    page.locator("[data-step-text]").getByText("Checking the issues.")
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-tool-chip]")).toHaveText("Issues");
  await expect(page.getByText("No issues match.")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Copy answer" })).toBeVisible();

  // Finished: the steps fold away, and the toggle brings them back.
  const toggle = page.getByRole("button", { name: /^1 step/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("Checking the issues.")).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.locator("[data-step-text]").getByText("Checking the issues.")
  ).toBeVisible();
  await expect(page.locator("[data-tool-chip]")).toHaveText("Issues");
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

// The caret goes back into the middle of text already there: the mention is
// typed and picked between two words, and the text around it stays.
test("picking a mention typed between existing words keeps the text around it", async ({
  page,
}) => {
  await page.goto("/en/assistant");
  const box = page.getByPlaceholder(ASK);
  await box.fill("ringkas  singkat");
  // Between the two spaces.
  await box.evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(8, 8);
  });
  await box.pressSequentially(`@${KEY}`);
  await page.getByRole("option", { name: PROJECT_NAME }).click();
  // The pick adds its own trailing space; the second original one follows.
  await expect(box).toHaveValue(`ringkas @${PROJECT_NAME}  singkat`);

  const sent = page.waitForRequest(
    (r) =>
      r.method() === "POST" && r.url().endsWith("/api/assistant/send-message")
  );
  await page.getByRole("button", { name: "Send" }).click();
  const body = (await sent).postDataJSON() as {
    text: string;
    context: { kind: string; projectId?: string };
  };
  expect(body.text).toBe(`ringkas @${PROJECT_NAME}  singkat`);
  const list = await page.request.get("/api/project-catalog/list-projects");
  const projects = (await list.json()) as { id: string; key: string }[];
  expect(body.context).toEqual({
    kind: "project",
    projectId: projects.find((p) => p.key === KEY)?.id,
  });
  await expect(page.getByText("lives in the auth module.")).toBeVisible({
    timeout: 30_000,
  });
});

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

const ANSWER = "lives in the auth module.";
const chatList = (page: import("@playwright/test").Page) =>
  page.getByRole("navigation", { name: "Chats" });

/** Asks `question` in the open composer and waits for the stub's answer. */
async function ask(page: import("@playwright/test").Page, question: string) {
  await page.getByPlaceholder(ASK).fill(question);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(ANSWER)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Copy answer" })).toBeVisible();
}

test("Home's box is New chat's: its draft carries over, and a send opens the chat", async ({
  page,
}) => {
  await page.goto("/en");
  const box = page.getByPlaceholder(ASK);
  // The whole box is the Assistant's composer group.
  await expect(
    page.locator("[data-slot=input-group]").filter({ has: box })
  ).toContainText("Automatic");
  const draft = `Home draft ${Date.now()}`;
  await box.fill(draft);
  // In-app navigation (drafts live in the tab's memory, not across reloads).
  await box.press("Control+j");
  await expect(page).toHaveURL(/\/en\/assistant$/);
  await expect(page.getByPlaceholder(ASK)).toHaveValue(draft);

  await page.goto("/en");
  const question = `Asked from Home ${Date.now()}`;
  await page.getByPlaceholder(ASK).fill(question);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/en\/assistant\?c=/);
  await expect(page.getByText(ANSWER)).toBeVisible({ timeout: 30_000 });
  await expect(chatList(page).getByText(question)).toBeVisible();
  // Sent: New chat's draft is empty again.
  await page.getByRole("button", { name: "New chat" }).click();
  await expect(page.getByPlaceholder(ASK)).toHaveValue("");
});

test("a pinned chat moves to Pinned, and search finds a chat by its text", async ({
  page,
}) => {
  await page.goto("/en/assistant");
  const title = `Pin me ${Date.now()}`;
  await ask(page, title);
  const row = chatList(page).getByRole("listitem").filter({ hasText: title });
  await row.hover();
  await row.getByRole("button", { name: "Chat actions" }).click();
  await page.getByRole("menuitem", { name: "Pin" }).click();
  const pinned = chatList(page)
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Pinned" }) });
  await expect(pinned.getByText(title)).toBeVisible();

  // The answer's text matches too; the title alone is unique to this run.
  const search = chatList(page).getByRole("searchbox", {
    name: "Search chats",
  });
  await search.fill(title.toUpperCase());
  await expect(chatList(page).getByRole("heading")).toHaveCount(0);
  await expect(chatList(page).getByRole("listitem")).toHaveCount(1);
  await expect(chatList(page).getByText(title)).toBeVisible();
  await search.press("Escape");
  await expect(pinned.getByText(title)).toBeVisible();

  // Unpinned again, so later runs start from the same list.
  await row.hover();
  await row.getByRole("button", { name: "Chat actions" }).click();
  await page.getByRole("menuitem", { name: "Unpin" }).click();
  await expect(pinned).toHaveCount(0);
});

test("a temporary chat is badged and never listed or found", async ({
  page,
}) => {
  await page.goto("/en/assistant");
  await page.getByRole("button", { name: "Temporary chat" }).click();
  await expect(
    page.getByRole("heading", { name: "Temporary chat" })
  ).toBeVisible();
  const question = `Off the record ${Date.now()}`;
  await ask(page, question);
  await expect(page.locator("[data-temporary-badge]")).toHaveText("Temporary");
  await expect(chatList(page).getByText(question)).toHaveCount(0);
  await chatList(page)
    .getByRole("searchbox", { name: "Search chats" })
    .fill(question);
  await expect(chatList(page).getByText("No chats found.")).toBeVisible();
  await page.reload();
  await expect(page.locator("[data-temporary-badge]")).toHaveText("Temporary");
  await expect(chatList(page).getByText(question)).toHaveCount(0);
});

test("the generated title shows in the list without a reload", async ({
  page,
}) => {
  await page.goto("/en/assistant");
  await ask(page, `Please name me ${Date.now()}`);
  await expect(
    chatList(page).locator('button[aria-current="true"]')
  ).toHaveText(NAMED_TITLE, { timeout: 30_000 });
});

test("Ctrl+Shift+O leaves the open chat for a new one", async ({ page }) => {
  await page.goto("/en/assistant");
  await ask(page, `Before the shortcut ${Date.now()}`);
  await expect(page).toHaveURL(/\?c=/);
  await page.keyboard.press("Control+Shift+O");
  await expect(page).not.toHaveURL(/\?c=/);
  await expect(
    page.getByRole("heading", { name: "What can I help with?" })
  ).toBeVisible();
  await expect(page.getByPlaceholder(ASK)).toBeFocused();
});

for (const path of ["/en", "/en/assistant"]) {
  test(`on ${path} the drop overlay covers exactly the input box, and the box's blank space focuses the text`, async ({
    page,
  }) => {
    await page.goto(path);
    const box = page.getByPlaceholder(ASK);
    const group = page.locator("[data-slot=input-group]").filter({ has: box });
    await expect(group).toBeVisible();
    await box.evaluate((el) => (el as HTMLTextAreaElement).blur());
    // Blank space in the toolbar row, just left of Send.
    const bounds = await group.boundingBox();
    if (!bounds) throw new Error("no bounds");
    await page.mouse.click(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height - 12
    );
    await expect(box).toBeFocused();

    const files = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["x"], "a.txt", { type: "text/plain" }));
      return transfer;
    });
    await group.dispatchEvent("dragenter", { dataTransfer: files });
    const overlay = group.getByText("Drop files to attach them");
    await expect(overlay).toBeVisible();
    const covered = await overlay.boundingBox();
    expect(covered).not.toBeNull();
    // Inside the box's border, the same rounded corners.
    expect(Math.abs((covered?.x ?? 0) - bounds.x)).toBeLessThanOrEqual(2);
    expect(Math.abs((covered?.width ?? 0) - bounds.width)).toBeLessThanOrEqual(
      2
    );
    expect(
      Math.abs((covered?.height ?? 0) - bounds.height)
    ).toBeLessThanOrEqual(2);
    const radius = await overlay.evaluate(
      (el) => getComputedStyle(el).borderTopLeftRadius
    );
    const groupRadius = await group.evaluate(
      (el) => getComputedStyle(el).borderTopLeftRadius
    );
    expect(radius).toBe(groupRadius);
    expect(groupRadius).not.toBe("0px");
  });
}
