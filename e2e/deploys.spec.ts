import { expect, type Locator, type Page, test } from "@playwright/test";
import postgres from "postgres";
import { AUTH_FILE } from "./support";

test.use({ storageState: AUTH_FILE });

// The Deploys timeline (Stage 10c) on seeded builds and deployments: the live
// badge, the failed row with its log, the confirming menu deploy, and the
// mobile and Arabic (RTL) layouts. The UI only reads what is seeded here; no
// CI or target server is involved. The e2e server runs with DEPLOY_REGISTRY
// blank, so a confirmed deploy gets the API's 503 and nothing runs.

// Unique per run, so a reused server (E2E_REUSE_SERVER=1) takes a rerun.
const RUN = Math.random().toString(36).slice(2, 6);
const KEY = `DP${RUN.replace(/[0-9]/g, "X").toUpperCase()}`;
const COMPONENT = `falcon-${RUN}`;
const LONG_TAG = `v9-${"long-tag-".repeat(12)}`.slice(0, 120);
const LONG_MESSAGE = `Rework the release pipeline ${"with a very long commit message ".repeat(8)}`;
const FAILED_LOG = "e2e: health check failed";
const MINUTE_MS = 60_000;

let envSlug = "";
let envId = "";
let sql: ReturnType<typeof postgres>;

test.beforeAll(async ({ request }) => {
  const project = await request.post("/api/project-catalog/add-project", {
    data: { data: { name: `E2E Deploys ${RUN}`, key: KEY } },
  });
  expect(project.ok()).toBe(true);
  const projectId = ((await project.json()) as { data: { id: string } }).data
    .id;
  const server = await request.post("/api/servers/create-server", {
    data: {
      data: {
        name: `E2E deploys server ${RUN}`,
        host: "192.0.2.30",
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
        host: "192.0.2.30:8080",
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
  const body = (await env.json()) as {
    data: { id: string; slug: string };
  };
  envSlug = body.data.slug;
  envId = body.data.id;

  sql = postgres(process.env.DATABASE_URL ?? "", {
    max: 1,
    onnotice: () => {},
  });
  const ago = (minutes: number) => new Date(Date.now() - minutes * MINUTE_MS);

  const [conn] = await sql<{ id: string }[]>`
    insert into ci_connections (name, provider, forge, base_url)
    values (${`E2E CI ${RUN}`}, 'woodpecker', 'bitbucket', 'https://ci.example.com')
    returning id`;
  await sql`
    insert into app_components
      (component_key, ci_connection_id, repo_full_name, bundle_image, notify_secret)
    values
      (${COMPONENT}, ${conn?.id ?? ""}, ${`acme/${COMPONENT}`}, ${`${COMPONENT}-deploy`}, 'e2e-not-a-secret')`;
  const [target] = await sql<{ id: string }[]>`
    insert into deploy_targets
      (environment_id, component_key, server_id, source_branch, kind, deploy_dir, services)
    values
      (${envId}, ${COMPONENT}, ${serverId}, 'main', 'compose', '/srv/falcon', ${["web"]})
    returning id`;
  const targetId = target?.id ?? "";

  const builds: [tag: string, minutesAgo: number, message: string][] = [
    ["v1", 300, "Initial release"],
    ["v2", 200, "Fix the login redirect"],
    ["v3", 100, "Add the audit export"],
    [LONG_TAG, 400, LONG_MESSAGE],
  ];
  const buildIds = new Map<string, string>();
  for (const [tag, minutesAgo, message] of builds) {
    const [row] = await sql<{ id: string }[]>`
      insert into builds
        (component_key, branch, tag, commit_sha, pipeline_url, commit_message, received_at)
      values
        (${COMPONENT}, 'main', ${tag}, ${`${tag.length}`.padEnd(40, "a")},
         ${tag === "v3" ? "https://ci.example.com/p/3" : null}, ${message}, ${ago(minutesAgo)})
      returning id`;
    buildIds.set(tag, row?.id ?? "");
  }

  async function deployment(
    tag: string,
    status: "success" | "failed",
    minutesAgo: number,
    scriptStarted: boolean,
    output: string
  ) {
    const [run] = await sql<{ id: string }[]>`
      insert into runs (environment_id, description, status, kind, output, run_at, completed_at)
      values (${envId}, ${`Deploy ${tag}`}, ${status}, 'deploy', ${output},
              ${ago(minutesAgo)}, ${ago(minutesAgo - 1)})
      returning id`;
    await sql`
      insert into deployments
        (target_id, environment_id, run_id, tag, trigger, status, build_id,
         created_at, started_at, script_started_at, finished_at)
      values
        (${targetId}, ${envId}, ${run?.id ?? ""}, ${tag}, 'manual', ${status},
         ${buildIds.get(tag) ?? null}, ${ago(minutesAgo)}, ${ago(minutesAgo)},
         ${scriptStarted ? ago(minutesAgo) : null}, ${ago(minutesAgo - 1)})`;
  }
  await deployment("v1", "success", 290, true, "ok");
  await deployment("v2", "success", 190, true, "ok");
  // Failed before the script started: the server never ran v3, so v2 stays live.
  await deployment("v3", "failed", 90, false, FAILED_LOG);
});

test.afterAll(async () => {
  // Deleting the environment cascades to its targets, deployments and runs;
  // the component (and its builds) and the connection go after the target.
  if (envId) await sql`delete from environments where id = ${envId}`;
  await sql`delete from app_components where component_key = ${COMPONENT}`;
  await sql`delete from ci_connections where name = ${`E2E CI ${RUN}`}`;
  await sql.end();
});

const deploysUrl = (locale: string) => `/${locale}/${KEY}/${envSlug}/deploys`;
const rowFor = (page: Page, tag: string) =>
  page
    .locator('[data-slot="timeline-row"]')
    .filter({ has: page.locator('[data-slot="row-tag"]', { hasText: tag }) });

/** Whether `inner`'s box centre sits left of `outer`'s. */
async function isLeftOf(inner: Locator, outer: Locator) {
  const [a, b] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
  if (!a || !b) throw new Error("element not rendered");
  return a.x + a.width / 2 < b.x + b.width / 2;
}

test("live badge, failed row and its log", async ({ page }) => {
  await page.goto(deploysUrl("en"));
  const live = page.locator('[data-slot="timeline-row"][data-status="live"]');
  await expect(live).toHaveCount(1);
  await expect(live).toContainText("v2");
  await expect(live).toContainText("Live");
  await expect(rowFor(page, "v3")).toHaveAttribute("data-status", "failed");

  const failure = page.locator('[data-slot="deploy-failure"]');
  await expect(failure).toContainText("Last deploy of v3 failed");
  await failure.getByRole("button", { name: "View log" }).click();
  await expect(page.getByRole("dialog")).toContainText(FAILED_LOG);
});

test("menu deploy asks for confirmation first", async ({ page }) => {
  await page.goto(deploysUrl("en"));
  await page.getByRole("button", { name: "Actions for v1" }).click();
  await page.getByRole("menuitem", { name: "Deploy this version" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Deploy v1?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: /^Deploy/ }).click();
  await expect(
    page.getByText(
      /Deploying is disabled: .* has no deploy registry configured\./
    )
  ).toBeVisible();
});

test("mobile: no horizontal page scroll with a long tag and message", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(deploysUrl("en"));
  const longRow = rowFor(page, LONG_TAG.slice(0, 20));
  await expect(longRow).toBeVisible();
  await expect(longRow.locator('[data-slot="tag-scroll"]')).toBeVisible();
  await expect(longRow).toContainText("Rework the release pipeline");

  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement;
    return el ? el.scrollWidth - el.clientWidth : 0;
  });
  expect(overflow).toBeLessThanOrEqual(1);

  // The row menu is on screen and opens.
  const trigger = longRow.getByRole("button", {
    name: `Actions for ${LONG_TAG}`,
  });
  await trigger.scrollIntoViewIfNeeded();
  const box = await trigger.boundingBox();
  if (!box) throw new Error("row menu trigger not rendered");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  await trigger.click();
  await expect(page.getByRole("menu")).toBeVisible();
});

test("ar: the row menu opens and is RTL, mirrored against LTR", async ({
  page,
}) => {
  await page.goto(deploysUrl("en"));
  const ltrRow = page.locator('[data-slot="timeline-row"]').first();
  await expect(ltrRow).toBeVisible();
  const ltrTrigger = ltrRow.locator('button[aria-haspopup="menu"]');
  // LTR: the menu trigger sits at the row's inline-end, the right.
  expect(await isLeftOf(ltrTrigger, ltrRow)).toBe(false);

  await page.goto(deploysUrl("ar"));
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const row = page.locator('[data-slot="timeline-row"]').first();
  await expect(row).toBeVisible();
  const trigger = row.locator('button[aria-haspopup="menu"]');
  // RTL: it mirrors to the left, visually opposite to LTR.
  expect(await isLeftOf(trigger, row)).toBe(true);
  await trigger.click();
  await expect(page.getByRole("menu")).toBeVisible();
});
