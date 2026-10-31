import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { AUTH_FILE } from "./support";

test.use({ storageState: AUTH_FILE });

const APP_URL = "https://app.example.com/login";

// A project with one environment bound to a placeholder server; nothing here
// connects to it. Each test seeds its own project (keys are unique).
async function seedEnvironment(request: APIRequestContext, key: string) {
  const project = await request.post("/api/project-catalog/add-project", {
    data: { data: { name: `E2E Env ${key}`, key } },
  });
  expect(project.ok()).toBe(true);
  const projectId = ((await project.json()) as { data: { id: string } }).data
    .id;

  const server = await request.post("/api/servers/create-server", {
    data: {
      data: {
        name: `E2E server ${key}`,
        host: "192.0.2.10",
        username: "ops",
        password: "secret",
      },
    },
  });
  expect(server.ok()).toBe(true);
  const serverId = ((await server.json()) as { data: { id: string } }).data.id;

  const env = await request.post("/api/environments/create-environment", {
    data: {
      data: {
        projectId,
        name: "Staging",
        host: "192.0.2.10:8080",
        url: APP_URL,
        dbServerId: serverId,
        dbServiceType: "docker",
        dbServiceName: "db",
        dbType: "postgres",
        dbName: "app",
        dbBackupPath: "/backups",
        backendServerId: serverId,
        backendServiceType: "docker",
        backendServiceName: "api",
        frontendServerId: serverId,
        frontendServiceType: "docker",
        frontendServiceName: "web",
      },
    },
  });
  expect(env.ok()).toBe(true);
  const body = (await env.json()) as {
    success: boolean;
    data: { slug: string };
  };
  expect(body.success).toBe(true);
  return { slug: body.data.slug };
}

// The overview row is a stretched link: the env name's link covers the whole
// row, with the URL icon layered above it.
function overviewRow(page: Page, key: string) {
  return page
    .locator(`a[href$="/${key}/staging"]`)
    .locator("xpath=ancestor::li[1]");
}

test("an environment row opens the environment, by name or empty row space", async ({
  page,
}) => {
  const key = "EROW";
  const { slug } = await seedEnvironment(page.request, key);

  await page.goto("/en/projects");
  const row = overviewRow(page, key);
  await row.getByRole("link", { name: "Staging", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/en/${key}/${slug}$`));

  // Empty space at the row's far end (beside the chevron) is the same link.
  await page.goto("/en/projects");
  const box = await overviewRow(page, key).boundingBox();
  if (!box) throw new Error("environment row not rendered");
  await page.mouse.click(box.x + box.width - 40, box.y + box.height / 2);
  await expect(page).toHaveURL(new RegExp(`/en/${key}/${slug}$`));
});

test("the URL icon opens a new tab and leaves the page where it is", async ({
  page,
}) => {
  const key = "EURL";
  await seedEnvironment(page.request, key);

  await page.goto("/en/projects");
  const icon = overviewRow(page, key).getByRole("link", {
    name: `Open ${APP_URL} in a new tab`,
  });
  await expect(icon).toHaveAttribute("href", APP_URL);
  await expect(icon).toHaveAttribute("target", "_blank");
  await expect(icon).toHaveAttribute("rel", /\bnoopener\b/);

  const before = page.url();
  const popupPromise = page.context().waitForEvent("page");
  await icon.click();
  const popup = await popupPromise;
  await popup.close();
  expect(page.url()).toBe(before);
});
