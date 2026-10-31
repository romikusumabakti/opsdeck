import { expect, test } from "@playwright/test";
import { AUTH_FILE } from "./support";

test.use({ storageState: AUTH_FILE });

test("creating an issue assigned to me updates the sidebar badge without a reload", async ({
  page,
}) => {
  const key = `E${Date.now().toString(36).slice(-6).toUpperCase()}`;

  await page.goto("/en/projects");
  await page.getByRole("button", { name: "New project" }).first().click();
  const projectDialog = page.getByRole("dialog");
  await projectDialog.getByLabel("Project name").fill(`E2E ${key}`);
  await projectDialog.getByLabel("Key").fill(key);
  await projectDialog.getByRole("button", { name: "Create project" }).click();
  await expect(projectDialog).toBeHidden();

  await page.goto(`/en/${key}`);
  await page.getByRole("tab", { name: /^Issues/ }).click();
  await expect(page.getByText(/assigned to you/)).toHaveCount(0);

  // Everything from here on must happen in the same document.
  await page.evaluate(() => {
    (window as unknown as { __noReload: boolean }).__noReload = true;
  });

  await page.getByRole("button", { name: "New issue" }).first().click();
  const issueDialog = page.getByRole("dialog");
  await issueDialog.getByLabel("Title").fill("Assigned to me");
  await issueDialog.getByRole("combobox", { name: "Assignee" }).click();
  await page.getByRole("option", { name: /E2E Admin/ }).click();
  await issueDialog.getByRole("button", { name: "Create issue" }).click();

  await expect(page.getByText("1 open issue assigned to you")).toBeAttached();
  expect(
    await page.evaluate(
      () => (window as unknown as { __noReload?: boolean }).__noReload
    )
  ).toBe(true);
});
