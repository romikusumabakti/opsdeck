import { expect, type Locator, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { AUTH_FILE } from "./support";

test.use({ storageState: AUTH_FILE });

// The New issue dialog (chips, Ctrl/⌘+Enter, Create more, the `/` menu) and
// the global list's title width, in a real browser.

const LABEL = "e2e-triage";
const LONG_TITLE =
  "Checkout total shows the pre-discount amount after a voucher is applied twice";

/** Labels come from Jira sync only, so the spec seeds one directly. */
async function seedLabel() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`insert into labels (name, color) values (${LABEL}, '#2563eb')
      on conflict (name) do nothing`;
  } finally {
    await sql.end();
  }
}

async function createProject(page: Page, key: string) {
  const res = await page.request.post("/api/project-catalog/add-project", {
    data: { data: { name: `E2E ${key}`, key } },
  });
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

/** A property chip in the dialog's chip row, by the property's name. */
function chip(dialog: Locator, name: string) {
  return dialog
    .getByRole("group", { name: "Properties" })
    .locator("button", { hasText: name });
}

test("New issue: chips, Ctrl/⌘+Enter, Create more and the / menu", async ({
  page,
}) => {
  await seedLabel();
  const key = `C${Date.now().toString(36).slice(-6).toUpperCase()}`;
  const projectId = await createProject(page, key);

  await page.goto(`/en/${key}/issues`);
  await page.getByRole("button", { name: "New issue" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New issue" });
  const title = dialog.getByLabel("Title");
  await expect(title).toBeVisible();

  // Properties through the chips.
  await chip(dialog, "Status").click();
  await page.getByRole("option", { name: "In progress" }).click();
  await expect(chip(dialog, "Status")).toContainText("In progress");
  await chip(dialog, "Priority").click();
  await page.getByRole("option", { name: "High" }).click();
  await expect(chip(dialog, "Priority")).toContainText("High");
  await chip(dialog, "Labels").click();
  await page.getByRole("button", { name: LABEL }).click();
  await page.keyboard.press("Escape");
  await expect(chip(dialog, "Labels")).toContainText(LABEL);
  await expect(dialog).toBeVisible();

  await dialog.getByRole("switch", { name: "Create more" }).click();

  // First issue: a heading from the `/` menu, created with Ctrl/⌘+Enter in
  // the description.
  await title.fill("Voucher field accepts expired codes");
  const description = dialog.locator(".ProseMirror");
  await description.click();
  await page.keyboard.type("/head");
  await expect(
    page.getByRole("listbox", { name: "Commands" }).getByRole("option", {
      name: "Heading 2",
    })
  ).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.type("Steps to reproduce");
  await expect(description.locator("h2")).toHaveText("Steps to reproduce");
  await page.keyboard.press("ControlOrMeta+Enter");

  // Create more: still open, text cleared, caret back in the title, the
  // chosen properties kept.
  await expect(title).toHaveValue("");
  await expect(title).toBeFocused();
  await expect(dialog).toBeVisible();
  await expect(chip(dialog, "Status")).toContainText("In progress");
  await expect(chip(dialog, "Priority")).toContainText("High");
  await expect(chip(dialog, "Labels")).toContainText(LABEL);

  // Second issue, from the title this time.
  await title.fill("Voucher field ignores trailing spaces");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(title).toHaveValue("");
  await expect(dialog).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Both exist, with the chips' properties.
  const list = await page.request.get(
    `/api/issues/list-all-issues?q=${encodeURIComponent(
      JSON.stringify({ projectId, limit: 50 })
    )}`
  );
  expect(list.ok()).toBe(true);
  const rows = (
    (await list.json()) as {
      rows: {
        title: string;
        status: string;
        priority: string;
        labels: { name: string }[];
        project: { key: string };
        number: number;
      }[];
    }
  ).rows;
  expect(rows.map((r) => r.title).sort()).toEqual([
    "Voucher field accepts expired codes",
    "Voucher field ignores trailing spaces",
  ]);
  for (const r of rows) {
    expect(r.status).toBe("in_progress");
    expect(r.priority).toBe("high");
    expect(r.labels.map((l) => l.name)).toEqual([LABEL]);
  }

  // The `/` heading is stored as Markdown and renders as a heading.
  const first = rows.find((r) => r.title.startsWith("Voucher field accepts"));
  await page.goto(`/en/${key}/issues/${first?.number}`);
  await expect(
    page.locator(".ProseMirror h2", { hasText: "Steps to reproduce" })
  ).toBeVisible();
});

test("global Issues shows 50+ title characters at 1280px and offers New issue", async ({
  page,
}) => {
  const key = `W${Date.now().toString(36).slice(-6).toUpperCase()}`;
  const projectId = await createProject(page, key);
  const created = await page.request.post("/api/issues/create-issue", {
    data: { data: { projectId, title: LONG_TITLE } },
  });
  expect(created.ok()).toBe(true);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/en/issues");
  await expect(
    page.locator('[data-slot="sidebar"][data-state="expanded"]')
  ).toBeAttached();

  const link = page.locator(`a[title="${LONG_TITLE}"]`);
  await expect(link).toBeVisible();
  // The link truncates with an ellipsis: compare its box with the width the
  // first 50 characters take in its own font.
  const { shown, needed } = await link.evaluate((el, text) => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    ctx.font = getComputedStyle(el).font;
    return {
      shown: el.getBoundingClientRect().width,
      needed: ctx.measureText(text.slice(0, 50)).width,
    };
  }, LONG_TITLE);
  expect(shown).toBeGreaterThanOrEqual(needed);

  // Still no horizontal scroll at this width.
  const scroller = page.locator('[data-slot="table-container"]').first();
  expect(
    await scroller.evaluate((el) => el.scrollWidth - el.clientWidth)
  ).toBeLessThanOrEqual(0);

  // New issue is offered here too, with the Project chip.
  await page.getByRole("button", { name: "New issue" }).click();
  const dialog = page.getByRole("dialog", { name: "New issue" });
  await expect(chip(dialog, "Project")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
