import { expect, test } from "@playwright/test";
import { AUTH_FILE } from "./support";

test.use({ storageState: AUTH_FILE });

test("a short table hugs its rows and renders no pager", async ({ page }) => {
  const created = await page.request.post("/api/project-catalog/add-project", {
    data: { data: { name: "E2E Short Table", key: "ESHT" } },
  });
  const project = (await created.json()) as { data: { id: string } };
  for (const title of ["Short issue one", "Short issue two"]) {
    const res = await page.request.post("/api/issues/create-issue", {
      data: { data: { projectId: project.data.id, title } },
    });
    expect(res.ok()).toBe(true);
  }

  await page.goto("/en/issues");
  await expect(
    page.getByRole("row", { name: /Short issue one/ })
  ).toBeVisible();

  // The bordered box around the table is the scroll container's parent.
  const box = page
    .locator('[data-slot="table-container"]')
    .first()
    .locator("..");
  const viewportHeight = page.viewportSize()?.height ?? 720;
  const height = (await box.boundingBox())?.height ?? Number.POSITIVE_INFINITY;
  expect(height).toBeLessThan(viewportHeight * 0.6);

  await expect(page.getByText("Rows per page")).toHaveCount(0);
  await expect(page.getByText(/^Showing /)).toHaveCount(0);
});

test("a long table is bounded, keeps its pager and a pinned header", async ({
  page,
}) => {
  const created = await page.request.post("/api/project-catalog/add-project", {
    data: { data: { name: "E2E Tables", key: "ETBL" } },
  });
  const project = (await created.json()) as { data: { id: string } };

  for (let i = 1; i <= 30; i++) {
    const res = await page.request.post("/api/issues/create-issue", {
      data: { data: { projectId: project.data.id, title: `Seed issue ${i}` } },
    });
    expect(res.ok()).toBe(true);
  }

  await page.goto("/en/issues");
  await expect(page.getByText("Rows per page")).toBeVisible();

  const scroller = page.locator('[data-slot="table-container"]').first();
  await expect(scroller).toBeVisible();
  const viewportHeight = page.viewportSize()?.height ?? 720;
  expect((await scroller.boundingBox())?.height ?? 0).toBeLessThan(
    viewportHeight
  );

  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const header = page.getByRole("columnheader").first();
  await expect(header).toBeInViewport();
  const scrollerTop = (await scroller.boundingBox())?.y ?? 0;
  const headerTop = (await header.boundingBox())?.y ?? -1;
  expect(Math.abs(headerTop - scrollerTop)).toBeLessThan(2);
});

test("global issues fit 1280px without horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/en/issues");
  const scroller = page.locator('[data-slot="table-container"]').first();
  await expect(scroller).toBeVisible();
  // Below 2xl the title takes the room Project/Created/Updated would use.
  await expect(
    page.getByRole("columnheader", { name: /Assignee/ })
  ).toBeVisible();
  const overflow = await scroller.evaluate(
    (el) => el.scrollWidth - el.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
