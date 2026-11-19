import { execFileSync, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The services model (Stage 8) on a real Postgres: the build hook and its
// auto-deploy for an app-linked legacy component and for a service registered
// without an app (Review Focus 1), deploy targets of services from several
// former apps in one environment, project services and their refusals
// (Review Focus 4), and the CLI registering a service. A scratch database in
// the local menara-postgres container (superuser password read from the
// container, never printed), migrated with `menara migrate`, dropped
// afterwards. Only the job queue and the CI provider are faked.
//
//   SERVICES_SCRATCH=1 bun --bun vitest run tests/services-scratch.test.ts
const enabled = process.env.SERVICES_SCRATCH === "1";
const CONTAINER = "menara-postgres";
const DB_NAME = "services_scratch";

const queue = vi.hoisted(() => ({ enqueue: vi.fn(async () => {}) }));
vi.mock("@/lib/queue", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  enqueue: queue.enqueue,
}));
// Who pushed a build is best-effort: no CI provider answers here.
vi.mock("@/server/services/ci-connections", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getProviderForConnection: vi.fn(async () => {
    throw new Error("no CI in the scratch test");
  }),
}));

const SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");
const id = (n: number) =>
  `019a0000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const PROJECT = id(1);
const OTHER_PROJECT = id(2);
const APP_CORE = id(11);
const APP_CMS = id(12);
const ENV = id(21);
const CI = id(31);
const SERVER = id(32);
const BRANCH = "kestrel/development";

/** The legacy component's notify secret, stored as the old CLI stored it. */
const LEGACY_SECRET = "legacy-notify-secret-0123456789abcdef";
const SERVICE_SECRET = "service-notify-secret-0123456789abcdef";

function psql(db: string, args: string[]) {
  return execFileSync(
    "podman",
    [
      "exec",
      CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      db,
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
}

/** The body the Woodpecker example's printf builds, byte for byte. */
function woodpeckerBody(componentKey: string, tag: string): string {
  return `{"app":"${componentKey}","branch":"${BRANCH}","tag":"${tag}","commit":"abc1234","pipelineUrl":"https://ci.example.invalid/repos/7/pipeline/3"}`;
}

const sign = (body: string, secret: string) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe.skipIf(!enabled)("services model on a real Postgres", () => {
  let sql: ReturnType<typeof postgres>;
  let url = "";
  let previousUrl: string | undefined;
  let app: typeof import("@/server/app").app;

  const deliver = (body: string, signature: string) =>
    app.request("/api/deploy-hooks/builds", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Menara-Signature": signature,
      },
      body,
    });

  beforeAll(async () => {
    const password = encodeURIComponent(
      execFileSync("podman", [
        "exec",
        CONTAINER,
        "printenv",
        "POSTGRES_PASSWORD",
      ])
        .toString()
        .trim()
    );
    url = `postgres://postgres:${password}@127.0.0.1:5432/${DB_NAME}`;
    psql("postgres", [
      "-c",
      `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`,
      "-c",
      `CREATE DATABASE ${DB_NAME}`,
    ]);
    const migrated = spawnSync("bun", ["scripts/cli.ts", "migrate"], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        DATABASE_URL: url,
      },
    });
    if (migrated.status !== 0) {
      throw new Error(`migrate failed: ${migrated.stderr}`);
    }
    // lib/db reads DATABASE_URL lazily, on the first query.
    previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url;
    vi.stubEnv("SECRETS_KEY", SECRETS_KEY);
    vi.stubEnv("DEPLOY_REGISTRY", "registry.example.invalid:5000");
    sql = postgres(url, { max: 2, onnotice: () => {} });

    await sql`insert into ci_connections (id, name, provider, forge, base_url) values
    (${CI}, 'Woodpecker', 'woodpecker', 'bitbucket', 'https://ci.example.invalid')`;
    await sql`insert into servers (id, name, host, username) values
    (${SERVER}, 'Server', '192.0.2.1', 'deploy')`;
    await sql`insert into projects (id, name, key) values
    (${PROJECT}, 'Kestrel', 'KES'), (${OTHER_PROJECT}, 'Osprey', 'OSP')`;
    await sql`insert into apps (id, app_key, name) values
    (${APP_CORE}, 'core', 'Core'), (${APP_CMS}, 'cms', 'CMS')`;
    // The legacy component, as the previous release registered it: an app,
    // the default notify secret name, a secret without the enc: prefix.
    await sql`insert into app_components
    (component_key, app_id, ci_connection_id, repo_full_name, ci_repo_id, bundle_image, notify_secret)
    values ('core-backend', ${APP_CORE}, ${CI}, 'team/core', '7', 'core-backend-deploy', ${LEGACY_SECRET}),
           ('cms-web', ${APP_CMS}, ${CI}, 'team/cms', '8', 'cms-web-deploy', 'cms-secret')`;
    // The environment adopted the core app, as the old rule did.
    await sql`insert into environments (id, project_id, name, slug, app_id)
    values (${ENV}, ${PROJECT}, 'Dev 1', 'dev-1', ${APP_CORE})`;

    const { encryptSecret } = await import("@/lib/secrets");
    const { insertServices } = await import("@/lib/service-catalog");
    await insertServices([
      {
        componentKey: "billing-api",
        ciConnectionId: CI,
        repoFullName: "team/billing",
        ciRepoId: "9",
        bundleImage: "billing-api-deploy",
        notifySecret: encryptSecret(SERVICE_SECRET),
      },
    ]);
    app = (await import("@/server/app")).app;
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await sql?.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    psql("postgres", ["-c", `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`]);
  });

  it("registers a service without an app", async () => {
    const [row] = await sql`select app_id, notify_secret_name
    from app_components where component_key = 'billing-api'`;
    expect(row).toEqual({ app_id: null, notify_secret_name: "menara_notify" });
    const { getComponent } = await import("@/lib/apps");
    const { getService } = await import("@/lib/service-catalog");
    // The deploy job and the hook read the service through getComponent.
    expect(await getComponent("billing-api")).toMatchObject({
      componentKey: "billing-api",
      appId: null,
      bundleImage: "billing-api-deploy",
    });
    expect(await getService("billing-api")).toMatchObject({
      key: "billing-api",
    });
  });

  it("adds targets of services from two former apps and an app-less one to one environment", async () => {
    const { db } = await import("@/lib/db");
    const { insertDeployTargetIn } = await import("@/server/services/deploys");
    const compose = (componentKey: string) => ({
      environmentId: ENV,
      componentKey,
      serverId: SERVER,
      sourceBranch: BRANCH,
      kind: "compose" as const,
      deployDir: `/opt/${componentKey}`,
      services: ["app"],
      tagVariable: "IMAGE_TAG",
      autoDeploy: true,
      healthTimeoutSeconds: 180,
      backupBeforeDeploy: false,
      preStartCommand: null,
      healthUrl: null,
    });
    for (const key of ["core-backend", "cms-web", "billing-api"]) {
      await db.transaction((tx) => insertDeployTargetIn(tx, compose(key)));
    }
    // No adoption: the environment's legacy app_id is left as it was.
    const [env] = await sql`select app_id from environments where id = ${ENV}`;
    expect(env?.app_id).toBe(APP_CORE);
    // Each target's service became a project service, with its branch.
    expect(
      await sql`select component_key from project_services
      where project_id = ${PROJECT} order by component_key`
    ).toEqual([
      { component_key: "billing-api" },
      { component_key: "cms-web" },
      { component_key: "core-backend" },
    ]);
    expect(
      await sql`select component_key, branch from project_component_branches
      where project_id = ${PROJECT} order by component_key`
    ).toEqual([
      { component_key: "billing-api", branch: BRANCH },
      { component_key: "cms-web", branch: BRANCH },
      { component_key: "core-backend", branch: BRANCH },
    ]);
    // Nothing goes to the retired table.
    expect(await sql`select 1 from project_apps`).toHaveLength(0);
  });

  it("an unknown service gets no target (404)", async () => {
    const { db } = await import("@/lib/db");
    const { insertDeployTargetIn } = await import("@/server/services/deploys");
    await expect(
      db.transaction((tx) =>
        insertDeployTargetIn(tx, {
          environmentId: ENV,
          componentKey: "no-such-service",
          serverId: SERVER,
          sourceBranch: BRANCH,
          kind: "compose",
          deployDir: "/opt/none",
          services: ["app"],
          tagVariable: "IMAGE_TAG",
          autoDeploy: false,
          healthTimeoutSeconds: 180,
          backupBeforeDeploy: false,
          preStartCommand: null,
          healthUrl: null,
        })
      )
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await sql`select 1 from deploy_targets where component_key = 'no-such-service'`
    ).toHaveLength(0);
  });

  describe("build hook (Review Focus 1)", () => {
    it.each([
      ["an app-linked legacy component", "core-backend", LEGACY_SECRET],
      ["a service registered without an app", "billing-api", SERVICE_SECRET],
    ])(
      "%s: an old-style notification records the build and auto-deploys once",
      async (_label, componentKey, secret) => {
        queue.enqueue.mockClear();
        const tag = `origin-kestrel-development-${componentKey.length}abc123`;
        const body = woodpeckerBody(componentKey, tag);
        const res = await deliver(body, sign(body, secret));
        expect(res.status).toBe(202);
        const accepted = (await res.json()) as {
          buildId: string;
          created: boolean;
          deploymentIds: string[];
        };
        expect(accepted.created).toBe(true);
        expect(accepted.deploymentIds).toHaveLength(1);

        const [build] =
          await sql`select id, component_key, branch, tag, commit_sha
        from builds where id = ${accepted.buildId}`;
        expect(build).toMatchObject({
          component_key: componentKey,
          branch: BRANCH,
          tag,
          commit_sha: "abc1234",
        });
        const [deployment] =
          await sql`select d.status, d.trigger, d.tag, t.component_key
        from deployments d join deploy_targets t on t.id = d.target_id
        where d.id = ${accepted.deploymentIds[0] as string}`;
        expect(deployment).toEqual({
          status: "queued",
          trigger: "auto",
          tag,
          component_key: componentKey,
        });
        expect(queue.enqueue).toHaveBeenCalledWith(
          "deploy/run.requested",
          expect.objectContaining({ deploymentId: accepted.deploymentIds[0] })
        );

        // A replay records nothing new and deploys nothing.
        queue.enqueue.mockClear();
        const replay = await deliver(body, sign(body, secret));
        expect(replay.status).toBe(202);
        expect(await replay.json()).toEqual({
          buildId: accepted.buildId,
          created: false,
          deploymentIds: [],
        });
        expect(queue.enqueue).not.toHaveBeenCalled();
      }
    );

    it("refuses another service's secret with 401 and records nothing", async () => {
      const body = woodpeckerBody("billing-api", "origin-x-1234567");
      const res = await deliver(body, sign(body, LEGACY_SECRET));
      expect(res.status).toBe(401);
      expect(
        await sql`select 1 from builds where tag = 'origin-x-1234567'`
      ).toHaveLength(0);
    });
  });

  describe("project services (Review Focus 4)", () => {
    it("lists the project's services with the environments that deploy them", async () => {
      const { loadProjectSources } = await import("@/lib/project-sources");
      const sources = await loadProjectSources(PROJECT);
      expect(sources.map((s) => [s.componentKey, s.inUse])).toEqual([
        ["billing-api", true],
        ["cms-web", true],
        ["core-backend", true],
      ]);
      expect(sources[0]).toEqual({
        componentKey: "billing-api",
        repoFullName: "team/billing",
        defaultBranch: BRANCH,
        fallbackBranch: "main",
        inUse: true,
        environments: [
          { id: ENV, name: "Dev 1", slug: "dev-1", sourceBranch: BRANCH },
        ],
      });
    });

    it("refuses to remove a service a deploy target uses, then removes it once unused", async () => {
      const { deleteProjectService } = await import("@/lib/project-sources");
      expect(await deleteProjectService(PROJECT, "cms-web")).toBe("inUse");
      expect(
        await sql`select 1 from project_services
        where project_id = ${PROJECT} and component_key = 'cms-web'`
      ).toHaveLength(1);

      await sql`delete from deploy_targets where component_key = 'cms-web'`;
      expect(await deleteProjectService(PROJECT, "cms-web")).toBe("deleted");
      expect(
        await sql`select 1 from project_component_branches
        where project_id = ${PROJECT} and component_key = 'cms-web'`
      ).toHaveLength(0);
      expect(await deleteProjectService(PROJECT, "cms-web")).toBe("absent");
    });

    it("adds any registered service to a project once; a target elsewhere does not count as in use", async () => {
      const { insertProjectService, serviceInUse } = await import(
        "@/lib/project-sources"
      );
      const { isProjectService } = await import("@/lib/service-catalog");
      expect(await insertProjectService(OTHER_PROJECT, "billing-api")).toBe(
        true
      );
      expect(await insertProjectService(OTHER_PROJECT, "billing-api")).toBe(
        false
      );
      expect(await isProjectService(OTHER_PROJECT, "billing-api")).toBe(true);
      expect(await serviceInUse(OTHER_PROJECT, "billing-api")).toBe(false);
      expect(await serviceInUse(PROJECT, "billing-api")).toBe(true);
    });
  });

  it("a target added while its service is removed from the project keeps the service there", async () => {
    const { db } = await import("@/lib/db");
    const { insertDeployTargetIn } = await import("@/server/services/deploys");
    const { deleteProjectService, insertProjectService } = await import(
      "@/lib/project-sources"
    );
    const RACE_ENV = id(22);
    await sql`insert into environments (id, project_id, name, slug)
    values (${RACE_ENV}, ${OTHER_PROJECT}, 'Race', 'race')`;
    await insertProjectService(OTHER_PROJECT, "cms-web");

    // The target's transaction is open (target row written, not committed)
    // when the removal starts.
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inserted = () => {};
    const targetWritten = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    const targetTx = db.transaction(async (tx) => {
      await insertDeployTargetIn(tx, {
        environmentId: RACE_ENV,
        componentKey: "cms-web",
        serverId: SERVER,
        sourceBranch: BRANCH,
        kind: "compose",
        deployDir: "/opt/race-cms",
        services: ["app"],
        tagVariable: "IMAGE_TAG",
        autoDeploy: false,
        healthTimeoutSeconds: 180,
        backupBeforeDeploy: false,
        preStartCommand: null,
        healthUrl: null,
      });
      inserted();
      await gate;
    });
    await targetWritten;
    let settled = false;
    // Any spelling of the project id takes the same lock.
    const removal = deleteProjectService(
      OTHER_PROJECT.toUpperCase(),
      "cms-web"
    ).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The removal waits for the target's transaction...
    expect(settled).toBe(false);
    release();
    await targetTx;
    // ...and then sees the target: the service stays.
    expect(await removal).toBe("inUse");
    expect(
      await sql`select 1 from project_services
      where project_id = ${OTHER_PROJECT} and component_key = 'cms-web'`
    ).toHaveLength(1);
  });

  it("a target added while a removal holds the lock waits, then adds its service back", async () => {
    const { db } = await import("@/lib/db");
    const { insertDeployTargetIn } = await import("@/server/services/deploys");
    const { insertProjectService } = await import("@/lib/project-sources");
    const RACE_ENV = id(22);
    await insertProjectService(OTHER_PROJECT, "core-backend");

    // A removal in progress: the lock (as deleteProjectService takes it) and
    // the row deleted, not committed yet.
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = () => {};
    const lockHeld = new Promise<void>((resolve) => {
      held = resolve;
    });
    const removal = sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended('project-services:' || ${OTHER_PROJECT}::uuid::text, 0))`;
      await tx`delete from project_services
      where project_id = ${OTHER_PROJECT} and component_key = 'core-backend'`;
      held();
      await gate;
    });
    await lockHeld;
    let settled = false;
    const targetTx = db
      .transaction((tx) =>
        insertDeployTargetIn(tx, {
          environmentId: RACE_ENV,
          componentKey: "core-backend",
          serverId: SERVER,
          sourceBranch: BRANCH,
          kind: "compose",
          deployDir: "/opt/race-core",
          services: ["app"],
          tagVariable: "IMAGE_TAG",
          autoDeploy: false,
          healthTimeoutSeconds: 180,
          backupBeforeDeploy: false,
          preStartCommand: null,
          healthUrl: null,
        })
      )
      .finally(() => {
        settled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The target waits for the removal...
    expect(settled).toBe(false);
    release();
    await removal;
    await targetTx;
    // ...and then adds its service again.
    expect(
      await sql`select 1 from project_services
      where project_id = ${OTHER_PROJECT} and component_key = 'core-backend'`
    ).toHaveLength(1);
  });

  describe("CLI (scripts/deploy-app.ts)", () => {
    const run = (args: string[]) =>
      spawnSync("bun", ["scripts/deploy-app.ts", ...args], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          DATABASE_URL: url,
          SECRETS_KEY,
        },
      });

    it("create registers a service without an app; --app only warns", async () => {
      const appsBefore = await sql`select count(*)::int as n from apps`;
      const plain = run([
        "create",
        "docs-site",
        "team/docs-site-bundle",
        "--repo",
        "team/docs",
      ]);
      expect(plain.status, plain.stderr).toBe(0);
      expect(plain.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
      const legacy = run([
        "create",
        "docs-worker",
        "team/docs-worker-bundle",
        "--app",
        "docs",
        "--repo",
        "team/docs-worker",
      ]);
      expect(legacy.status, legacy.stderr).toBe(0);
      expect(legacy.stderr).toContain("--app is deprecated and ignored");

      expect(
        await sql`select component_key, app_id from app_components
        where component_key in ('docs-site', 'docs-worker') order by 1`
      ).toEqual([
        { component_key: "docs-site", app_id: null },
        { component_key: "docs-worker", app_id: null },
      ]);
      expect(await sql`select count(*)::int as n from apps`).toEqual(
        appsBefore
      );

      // The printed secret is the one the hook verifies.
      const secret = plain.stdout.trim();
      const body = woodpeckerBody("docs-site", "origin-docs-1234567");
      expect((await deliver(body, sign(body, secret))).status).toBe(202);
    }, 60_000);

    it("create on a repository that already builds a service names its own notify secret", async () => {
      const result = run([
        "create",
        "docs-search",
        "team/docs-search-bundle",
        "--repo",
        "team/docs",
      ]);
      expect(result.status, result.stderr).toBe(0);
      // Never the repository's menara_notify, which docs-site reads.
      expect(result.stderr).toContain("menara_notify_docs_search");
      expect(result.stderr).not.toMatch(/secret menara_notify\./);
      expect(
        await sql`select notify_secret_name from app_components
        where component_key in ('docs-site', 'docs-search') order by component_key`
      ).toEqual([
        { notify_secret_name: "menara_notify_docs_search" },
        { notify_secret_name: "menara_notify" },
      ]);
      const secret = result.stdout.trim();
      const body = woodpeckerBody("docs-search", "origin-docs-7654321");
      expect((await deliver(body, sign(body, secret))).status).toBe(202);
    }, 60_000);
  });
});
