import { expect, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { AUTH_FILE } from "./support";
import { startWoodpeckerStub, type WoodpeckerStub } from "./woodpecker-stub";

test.use({ storageState: AUTH_FILE });

// Services (Stage 8) end to end: an admin registers two services of one
// repository in Admin › Services (against a local Woodpecker stub), adds
// them to a project's Sources, adds a deploy target of one to an
// environment, then creates a new environment from a copy of it that also
// deploys the other service.

// Unique per run, so a reused server (E2E_REUSE_SERVER=1) takes a rerun.
const RUN = Math.random().toString(36).slice(2, 6);
const KEY = `SV${RUN.replace(/[0-9]/g, "X").toUpperCase()}`;
const API = `kestrel-${RUN}`;
const WORKER = `kestrel-worker-${RUN}`;
const SERVER_NAME = `E2E services ${RUN}`;
const REPO = {
  id: 7,
  fullName: `acme/${API}`,
  forgeRemoteId: `{${RUN}}`,
};

let stub: WoodpeckerStub;

test.beforeAll(async ({ request }) => {
  stub = await startWoodpeckerStub([REPO]);
  // CI connections come from the installer (no UI creates one): insert the
  // row, then give it the stub's URL and a token through the admin API,
  // which encrypts the token.
  const sql = postgres(process.env.DATABASE_URL ?? "", {
    max: 1,
    onnotice: () => {},
  });
  const [row] = await sql<{ id: string }[]>`
    insert into ci_connections (name, provider, forge, base_url)
    values (${`E2E Woodpecker ${RUN}`}, 'woodpecker', 'bitbucket', ${stub.baseUrl})
    returning id`;
  await sql.end();
  const patched = await request.patch(`/api/ci-connections/${row?.id}`, {
    data: { baseUrl: stub.baseUrl, apiToken: "e2e-woodpecker-token" },
  });
  expect(patched.ok()).toBe(true);
});

test.afterAll(async () => {
  await stub?.close();
});

async function pick(page: Page, triggerId: string, option: string | RegExp) {
  await page.locator(`#${triggerId}`).click();
  await page.getByRole("option", { name: option }).click();
}

test("register services, add them to a project, target one, then create an environment with both", async ({
  page,
}) => {
  test.setTimeout(90_000);
  // A project with one environment on a placeholder server; nothing here
  // connects to it.
  const project = await page.request.post("/api/project-catalog/add-project", {
    data: { data: { name: "E2E Services", key: KEY } },
  });
  expect(project.ok()).toBe(true);
  const server = await page.request.post("/api/servers/create-server", {
    data: {
      data: {
        name: SERVER_NAME,
        host: "192.0.2.20",
        username: "ops",
        password: "secret",
      },
    },
  });
  expect(server.ok()).toBe(true);
  const serverId = ((await server.json()) as { data: { id: string } }).data.id;
  const projectId = ((await project.json()) as { data: { id: string } }).data
    .id;
  const env = await page.request.post("/api/environments/create-environment", {
    data: {
      data: {
        projectId,
        name: "Staging",
        host: "192.0.2.20:8080",
        url: "https://staging.example.com",
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
  const staging = ((await env.json()) as { data: { slug: string } }).data.slug;

  // Admin › Services: register two services of one repository.
  await page.goto("/en/admin/services");
  await expect(
    page.getByRole("heading", { name: "Services", exact: true })
  ).toBeVisible();
  await page.getByRole("button", { name: "Register service" }).click();
  const dialog = page.getByRole("dialog", { name: "Register services" });
  await pick(page, "register-connection", `E2E Woodpecker ${RUN}`);
  await pick(page, "register-repository", REPO.fullName);
  await expect(dialog.locator("#register-key-0")).toHaveValue(API);
  await dialog.getByRole("button", { name: "Add another service" }).click();
  await dialog.locator("#register-key-1").fill(WORKER);
  await dialog.getByRole("button", { name: "Register", exact: true }).click();
  await expect(dialog).toBeHidden();
  const list = page.getByRole("table");
  await expect(
    list.getByRole("link", { name: API, exact: true })
  ).toBeVisible();
  await expect(
    list.getByRole("link", { name: WORKER, exact: true })
  ).toBeVisible();
  expect(stub.calls).toContain("POST /api/repos");
  expect(stub.calls).toContain("POST /api/repos/7/secrets");

  // A service's page.
  await list.getByRole("link", { name: WORKER, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/en/admin/services/${WORKER}$`));
  // The repository's second service reads its own notify secret.
  await expect(
    page.getByText(`menara_notify_${WORKER.replaceAll("-", "_")}`)
  ).toBeVisible();
  await expect(
    page.getByText("No project uses this service yet.")
  ).toBeVisible();

  // Project settings › Sources: add both.
  await page.goto(`/en/${KEY}/settings?tab=sources`);
  for (const service of [API, WORKER]) {
    await page.getByRole("button", { name: "Add service" }).first().click();
    const add = page.getByRole("dialog", {
      name: "Add a service to this project",
    });
    await add.getByRole("combobox", { name: "Select a service" }).click();
    await page
      .getByRole("option", { name: new RegExp(`^${service} `) })
      .click();
    await add.getByRole("button", { name: "Add", exact: true }).click();
    await expect(add).toBeHidden();
    await expect(
      page
        .locator('[data-slot="card-title"]')
        .getByText(service, { exact: true })
    ).toBeVisible();
  }

  // Staging › Settings › Source & Deploy: a target of kestrel-api, picked
  // from the project's services.
  await page.goto(`/en/${KEY}/${staging}/settings?tab=source&add=target`);
  const target = page.getByRole("dialog", { name: "Add deploy target" });
  await pick(page, "target-component", new RegExp(`^${API}`));
  await pick(page, "target-server", SERVER_NAME);
  await target.locator("#target-source-branch").fill("main");
  await target.locator("#target-deploy-dir").fill("/opt/kestrel");
  await target.locator("#target-services").fill("api");
  await target.getByRole("button", { name: "Add target" }).click();
  await expect(target).toBeHidden();

  // New environment: a copy of Staging (its kestrel-api) plus kestrel-worker.
  await page.goto(`/en/${KEY}/environments/new`);
  await expect(page.locator("#env-start-from")).toContainText(
    "Copy of Staging"
  );
  await expect(page.getByText(API, { exact: true })).toBeVisible();
  await page.locator("#env-service-picker").click();
  await page.getByRole("option", { name: new RegExp(`^${WORKER}`) }).click();
  await expect(page.getByText(WORKER, { exact: true })).toBeVisible();
  await page.locator("#env-name").fill("QA 1");
  await pick(page, "env-server", SERVER_NAME);
  await page.getByRole("button", { name: "Create & deploy" }).click();
  await expect(page).toHaveURL(new RegExp(`/en/${KEY}/qa-1/deploys$`), {
    timeout: 30_000,
  });
  for (const service of [API, WORKER]) {
    await expect(
      page
        .locator('[data-slot="card-title"]')
        .getByText(service, { exact: true })
    ).toBeVisible();
  }
});

test("old repository and app URLs land on Services", async ({ page }) => {
  // A key no retired app has but a service has: that service's page.
  await page.goto(`/en/admin/repositories/${API}`);
  await expect(page).toHaveURL(new RegExp(`/en/admin/services/${API}$`));
  await page.goto(`/en/apps/${WORKER}/variables`);
  await expect(page).toHaveURL(new RegExp(`/en/admin/services/${WORKER}$`));
  // Unknown: the list.
  await page.goto("/en/apps/no-such-app");
  await expect(page).toHaveURL(/\/en\/admin\/services$/);
  await page.goto("/en/admin/repositories");
  await expect(page).toHaveURL(/\/en\/admin\/services$/);
  // The list filtered by repository, as a multi-service app's URL leads.
  await page.goto(
    `/en/admin/services?repo=${encodeURIComponent(REPO.fullName)}`
  );
  const list = page.getByRole("table");
  await expect(
    list.getByRole("link", { name: API, exact: true })
  ).toBeVisible();
  await expect(list.getByRole("row")).toHaveCount(3);
});
