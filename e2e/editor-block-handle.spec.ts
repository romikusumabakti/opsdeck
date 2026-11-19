import { expect, type Locator, type Page, test } from "@playwright/test";
import { AUTH_FILE } from "./support";

test.use({ storageState: AUTH_FILE });

// The markdown editor's block handle (TipTap DragHandle: "+" opens the `/`
// menu at the hovered block, the grip drags it), the "Type / for commands"
// hint on the caret's empty line, and equal-width row controls in the issues
// table — all layout-dependent, so only a real browser can check them.

async function post<T>(page: Page, path: string, data: unknown): Promise<T> {
  const res = await page.request.post(path, { data: { data } });
  expect(res.ok(), `${path}: ${res.status()}`).toBe(true);
  return ((await res.json()) as { data: T }).data;
}

async function createDoc(page: Page, title: string) {
  const collection = await post<{ id: string }>(
    page,
    "/api/knowledge/create-collection",
    { name: `E2E ${title}` }
  );
  return post<{ slug: string }>(page, "/api/knowledge/create-document", {
    collectionId: collection.id,
    title,
    content: "Alpha line\n\nBravo line\n\nCharlie line",
  });
}

const paragraphs = (editor: Locator) =>
  editor.locator(":scope > p").allTextContents();

test("+ opens the / menu below the hovered block and the grip reorders blocks", async ({
  page,
}) => {
  const doc = await createDoc(page, "Block handle");
  await page.goto(`/en/knowledge/${doc.slug}/edit`);
  const editor = page.locator(".ProseMirror");
  await expect(editor).toContainText("Charlie line");
  const plus = page.getByRole("button", { name: "Add a block below" });
  const grip = page.locator('[data-slot="block-drag-grip"]');

  // Hidden until a block is hovered; then it sits at the block's start side.
  await expect(plus).toBeHidden();
  const bravo = editor.locator(":scope > p", { hasText: "Bravo line" });
  await bravo.hover();
  await expect(plus).toBeVisible();
  const bravoBox = await bravo.boundingBox();
  const handleBox = await grip.boundingBox();
  expect(handleBox && bravoBox).toBeTruthy();
  if (handleBox && bravoBox) {
    expect(handleBox.x + handleBox.width).toBeLessThanOrEqual(bravoBox.x + 1);
    expect(Math.abs(handleBox.y - bravoBox.y)).toBeLessThan(8);
  }

  await plus.click();
  await expect(
    page.getByRole("listbox", { name: "Commands" }).getByRole("option", {
      name: "Code block",
    })
  ).toBeVisible();
  expect(await paragraphs(editor)).toEqual([
    "Alpha line",
    "Bravo line",
    "/",
    "Charlie line",
  ]);
  // The caret is after the `/`: typing filters, Enter runs.
  await page.keyboard.type("table");
  await page.keyboard.press("Enter");
  await expect(editor.locator("table")).toBeVisible();
  // Typing hid the handle (it never takes the focus).
  await expect(plus).toBeHidden();
  await expect(editor).toBeFocused();

  // Drag Charlie above Alpha by its grip.
  const charlie = editor.locator(":scope > p", { hasText: "Charlie line" });
  await charlie.hover();
  await expect(grip).toBeVisible();
  const alpha = editor.locator(":scope > p", { hasText: "Alpha line" });
  await grip.dragTo(alpha, { targetPosition: { x: 20, y: 2 } });
  await expect
    .poll(async () => (await paragraphs(editor)).filter((t) => t !== ""))
    .toEqual(["Charlie line", "Alpha line", "Bravo line"]);
});

test("the / hint shows on the caret's empty line mid-document", async ({
  page,
}) => {
  const doc = await createDoc(page, "Hint line");
  await page.goto(`/en/knowledge/${doc.slug}/edit`);
  const editor = page.locator(".ProseMirror");
  const alpha = editor.locator(":scope > p", { hasText: "Alpha line" });
  await alpha.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");

  const hint = (el: Locator) =>
    el.evaluate((node) => getComputedStyle(node, "::before").content);
  const empty = editor.locator(":scope > p").nth(1);
  await expect(empty).toHaveText("");
  await expect.poll(() => hint(empty)).toBe('"Type / for commands"');
  // Not on the lines with text.
  expect(await hint(alpha)).toBe("none");
  // Gone once something is typed there.
  await page.keyboard.type("x");
  await expect.poll(() => hint(empty)).toBe("none");
});

test("in Arabic the handle sits on the right of the block", async ({
  page,
}) => {
  const doc = await createDoc(page, "RTL handle");
  await page.goto(`/ar/knowledge/${doc.slug}/edit`);
  const editor = page.locator(".ProseMirror");
  const bravo = editor.locator(":scope > p", { hasText: "Bravo line" });
  await bravo.hover();
  const grip = page.locator('[data-slot="block-drag-grip"]');
  await expect(grip).toBeVisible();
  const bravoBox = await bravo.boundingBox();
  const gripBox = await grip.boundingBox();
  expect(gripBox && bravoBox).toBeTruthy();
  if (gripBox && bravoBox) {
    expect(gripBox.x).toBeGreaterThanOrEqual(bravoBox.x + bravoBox.width - 1);
  }
});

test("issue row controls have the same width in every row, chevron on hover", async ({
  page,
}) => {
  const key = `W${Date.now().toString(36).slice(-6).toUpperCase()}`;
  const project = await post<{ id: string }>(
    page,
    "/api/project-catalog/add-project",
    { name: `E2E ${key}`, key }
  );
  // Values of very different lengths, so content-width triggers would differ.
  await post(page, "/api/issues/create-issue", {
    projectId: project.id,
    title: "Short values",
    status: "open",
    priority: "low",
  });
  await post(page, "/api/issues/create-issue", {
    projectId: project.id,
    title: "Long values",
    status: "in_progress",
    priority: "urgent",
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/en/${key}/issues`);
  const short = page.getByRole("row", { name: /Short values/ });
  const long = page.getByRole("row", { name: /Long values/ });
  await expect(short).toBeVisible();
  await expect(long).toBeVisible();

  const widths = async (row: Locator) => {
    const triggers = row.locator(
      '[data-slot="select-trigger"], [data-slot="combobox-trigger"]'
    );
    await expect(triggers).toHaveCount(3);
    return Promise.all(
      [0, 1, 2].map(
        async (i) => (await triggers.nth(i).boundingBox())?.width ?? 0
      )
    );
  };
  const [a, b] = [await widths(short), await widths(long)];
  for (let i = 0; i < 3; i++) {
    expect(a[i]).toBeGreaterThan(0);
    expect(Math.abs((a[i] ?? 0) - (b[i] ?? 0))).toBeLessThan(1);
  }

  // The chevron rests hidden and shows on row hover, at the trigger's end.
  const status = short.locator('[data-slot="select-trigger"]').first();
  const chevron = status.locator("> svg").last();
  await page.mouse.move(0, 0);
  await expect(chevron).toHaveCSS("opacity", "0");
  await short.hover();
  await expect(chevron).toHaveCSS("opacity", "1");
  const statusBox = await status.boundingBox();
  const chevronBox = await chevron.boundingBox();
  if (statusBox && chevronBox) {
    expect(
      statusBox.x + statusBox.width - (chevronBox.x + chevronBox.width)
    ).toBeLessThan(12);
  }
});
