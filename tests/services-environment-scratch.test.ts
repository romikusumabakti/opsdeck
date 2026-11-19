import { execFileSync, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Review Focus 3 (Stage 8, services model) on a real Postgres: an environment
// deploying services from two former apps, end to end. The setup wizard
// creates it with a target per service (no app), the build hook auto-deploys
// one of them, its variables start from the merged templates of both
// services, Fill from template reports their conflict and fills the user's
// pick, the managed .env needs every name either service requires, and the
// strictest escrow holds. A scratch database in the local menara-postgres
// container (superuser password read from the container, never printed),
// migrated with `menara migrate`, dropped afterwards. Only the session and
// the project permission check, the job queue and the CI provider are faked.
//
//   SERVICES_SCRATCH=1 bun --bun vitest run tests/services-environment-scratch.test.ts
const enabled = process.env.SERVICES_SCRATCH === "1";
const CONTAINER = "menara-postgres";
const DB_NAME = "services_environment_scratch";

const id = (n: number) =>
  `019a0000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const USER = id(1);
const PROJECT = id(2);
const APP_CORE = id(11);
const APP_CMS = id(12);
const CI = id(31);
const SERVER = id(32);
const BRANCH = "kestrel/qa";
const CMS_SECRET = "cms-legacy-notify-secret-0123456789";

const session = vi.hoisted(() => ({
  user: {
    id: "019a0000-0000-7000-8000-000000000001",
    role: "admin",
    name: "Kestrel Admin",
  },
  session: { signInMethod: "passkey" },
}));
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));
vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => session),
  getServerSession: vi.fn(async () => session),
}));
vi.mock("@/lib/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authz")>()),
  requireProjectPermission: vi.fn(async () => ({
    session,
    role: "engineer",
    projectId: "019a0000-0000-7000-8000-000000000002",
  })),
}));
const queue = vi.hoisted(() => ({ enqueue: vi.fn(async () => {}) }));
vi.mock("@/lib/queue", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  enqueue: queue.enqueue,
}));
vi.mock("@/server/services/ci-connections", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getProviderForConnection: vi.fn(async () => {
    throw new Error("no CI in the scratch test");
  }),
}));

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

describe.skipIf(!enabled)(
  "an environment of services from two former apps",
  () => {
    let sql: ReturnType<typeof postgres>;
    let previousUrl: string | undefined;
    let envId = "";

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
      const url = `postgres://postgres:${password}@127.0.0.1:5432/${DB_NAME}`;
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
      previousUrl = process.env.DATABASE_URL;
      process.env.DATABASE_URL = url;
      vi.stubEnv("SECRETS_KEY", Buffer.alloc(32, 5).toString("base64"));
      vi.stubEnv("DEPLOY_REGISTRY", "registry.example.invalid:5000");
      sql = postgres(url, { max: 2, onnotice: () => {} });

      await sql`insert into users (id, name, email, email_verified, role) values
    (${USER}, 'Kestrel Admin', 'admin@example.test', true, 'admin')`;
      await sql`insert into ci_connections (id, name, provider, forge, base_url) values
    (${CI}, 'Woodpecker', 'woodpecker', 'bitbucket', 'https://ci.example.invalid')`;
      await sql`insert into servers (id, name, host, username, placement) values
    (${SERVER}, 'Kestrel server', '192.0.2.10', 'deploy', 'open')`;
      await sql`insert into projects (id, name, key, default_server_id) values
    (${PROJECT}, 'Kestrel', 'KES', ${SERVER})`;
      // Two former apps, one component each, as the previous release had them.
      await sql`insert into apps (id, app_key, name) values
    (${APP_CORE}, 'core', 'Core'), (${APP_CMS}, 'cms', 'CMS')`;
      await sql`insert into app_components
    (component_key, app_id, ci_connection_id, repo_full_name, ci_repo_id, bundle_image, notify_secret)
    values ('core-backend', ${APP_CORE}, ${CI}, 'team/core', '7', 'core-backend-deploy', 'core-secret'),
           ('cms-web', ${APP_CMS}, ${CI}, 'team/cms', '8', 'cms-web-deploy', ${CMS_SECRET})`;
      // Their templates: one identical, one differing default (a conflict),
      // one generated whose length and escrow differ.
      await sql`insert into service_variable_templates
    (component_key, name, kind, required, default_value, generated_length, escrow) values
    ('core-backend', 'APP_MODE', 'plain', false, 'qa', null, false),
    ('cms-web', 'APP_MODE', 'plain', false, 'qa', null, false),
    ('core-backend', 'MAIL_FROM', 'plain', true, 'core@example.test', null, false),
    ('cms-web', 'MAIL_FROM', 'plain', false, 'cms@example.test', null, false),
    ('core-backend', 'SESSION_KEY', 'generated', false, null, 48, false),
    ('cms-web', 'SESSION_KEY', 'generated', false, null, 64, true)`;
    }, 120_000);

    afterAll(async () => {
      vi.unstubAllEnvs();
      await sql?.end();
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
      psql("postgres", [
        "-c",
        `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`,
      ]);
    });

    it("the wizard creates it with a target per service and the merged templates' variables", async () => {
      const { createEnvironmentSetup } = await import(
        "@/server/services/environment-setup"
      );
      const target = (componentKey: string) => ({
        componentKey,
        sourceBranch: BRANCH,
        autoDeploy: true,
        deployDir: `/deployments/kes-qa-${componentKey}`,
        services: ["app"],
        tagVariable: "IMAGE_TAG",
        preStartCommand: null,
        healthUrl: null,
        healthTimeoutSeconds: 180,
        backupBeforeDeploy: false,
      });
      const created = await createEnvironmentSetup({
        projectId: PROJECT,
        name: "QA",
        server: { serverId: SERVER },
        targets: [target("core-backend"), target("cms-web")],
        services: [{ role: "backend", serviceName: "kes-qa-app-1" }],
        database: { kind: "none" },
        // The services disagree on MAIL_FROM, which one requires: entered.
        variables: [
          { name: "MAIL_FROM", kind: "plain", value: "qa@example.test" },
        ],
        domain: { kind: "none" },
      });
      envId = created.environmentId;

      const [env] = await sql`select app_id, env_file_managed
    from environments where id = ${envId}`;
      expect(env).toEqual({ app_id: null, env_file_managed: true });
      expect(
        await sql`select component_key, deploy_dir from deploy_targets
      where environment_id = ${envId} order by component_key`
      ).toEqual([
        { component_key: "cms-web", deploy_dir: "/deployments/kes-qa-cms-web" },
        {
          component_key: "core-backend",
          deploy_dir: "/deployments/kes-qa-core-backend",
        },
      ]);
      expect(
        await sql`select component_key from project_services
      where project_id = ${PROJECT} order by 1`
      ).toEqual([
        { component_key: "cms-web" },
        { component_key: "core-backend" },
      ]);
      expect(await sql`select 1 from project_apps`).toHaveLength(0);

      const vars = await sql`select name, kind, value, escrow
    from environment_variables where environment_id = ${envId} order by name`;
      expect(vars.map((v) => [v.name, v.kind, v.escrow])).toEqual([
        ["APP_MODE", "plain", false],
        ["MAIL_FROM", "plain", false],
        // The strictest of the two: escrowed, 64 characters.
        ["SESSION_KEY", "generated", true],
      ]);
      const { decryptSecret } = await import("@/lib/secrets");
      expect(decryptSecret(vars[2]?.value as string)).toHaveLength(64);
      expect(vars[1]?.value).toBe("qa@example.test");
    }, 60_000);

    it("a build of either service auto-deploys to it", async () => {
      const { app } = await import("@/server/app");
      queue.enqueue.mockClear();
      const tag = "origin-kestrel-qa-1abc234";
      const body = `{"app":"cms-web","branch":"${BRANCH}","tag":"${tag}","commit":"1abc234","pipelineUrl":"https://ci.example.invalid/repos/8/pipeline/1"}`;
      const res = await app.request("/api/deploy-hooks/builds", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Menara-Signature": `sha256=${createHmac("sha256", CMS_SECRET).update(body).digest("hex")}`,
        },
        body,
      });
      expect(res.status).toBe(202);
      const { deploymentIds } = (await res.json()) as {
        deploymentIds: string[];
      };
      expect(deploymentIds).toHaveLength(1);
      const [deployment] =
        await sql`select d.status, t.environment_id, t.component_key
    from deployments d join deploy_targets t on t.id = d.target_id
    where d.id = ${deploymentIds[0] as string}`;
      expect(deployment).toEqual({
        status: "queued",
        environment_id: envId,
        component_key: "cms-web",
      });
      expect(queue.enqueue).toHaveBeenCalledWith(
        "deploy/run.requested",
        expect.objectContaining({ deploymentId: deploymentIds[0] })
      );
    });

    it("Fill from template reports the conflict, then fills the user's pick", async () => {
      const { applyTemplate, setEnvFileManaged } = await import(
        "@/server/services/variables"
      );
      await sql`delete from environment_variables
    where environment_id = ${envId} and name = 'MAIL_FROM'`;
      await sql`update environments set env_file_managed = false where id = ${envId}`;

      // Required by one service: the managed .env cannot be turned on.
      await expect(setEnvFileManaged(envId, true)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("MAIL_FROM"),
      });

      expect(await applyTemplate(envId)).toEqual({
        added: [],
        missing: ["MAIL_FROM"],
        conflicts: [
          {
            name: "MAIL_FROM",
            required: true,
            options: [
              {
                componentKeys: ["cms-web"],
                kind: "plain",
                defaultValue: "cms@example.test",
              },
              {
                componentKeys: ["core-backend"],
                kind: "plain",
                defaultValue: "core@example.test",
              },
            ],
          },
        ],
      });
      expect(
        await applyTemplate(envId, { choices: { MAIL_FROM: "core-backend" } })
      ).toEqual({ added: ["MAIL_FROM"], missing: [], conflicts: [] });
      const [mail] = await sql`select value from environment_variables
    where environment_id = ${envId} and name = 'MAIL_FROM'`;
      expect(mail?.value).toBe("core@example.test");
      await expect(setEnvFileManaged(envId, true)).resolves.toEqual({
        envFileManaged: true,
      });
    });

    it("keeps the variable one service escrows from being regenerated", async () => {
      const { regenerateVariable } = await import(
        "@/server/services/variables"
      );
      await expect(
        regenerateVariable(envId, "SESSION_KEY")
      ).rejects.toMatchObject({ status: 409 });
    });
  }
);
