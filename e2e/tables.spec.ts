import { expect, test } from "@playwright/test";
import { AUTH_FILE } from "./support";

test.use({ storageState: AUTH_FILE });

test("a short table hugs its rows and renders no pager", async ({ page }) => {
  for (const name of ["Archive", "Media"]) {
    const res = await page.request.post(
      "/api/s3-connections/create-s3-connection",
      {
        data: {
          data: {
            name: `E2E ${name}`,
            endpoint: "http://localhost:9000",
            region: "us-east-1",
            bucket: name.toLowerCase(),
            accessKeyId: "key",
            secretKey: "secret",
            forcePathStyle: true,
          },
        },
      }
    );
    expect(res.ok()).toBe(true);
  }

  await page.goto("/en/storage");
  await expect(page.getByRole("row", { name: /E2E Archive/ })).toBeVisible();

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
