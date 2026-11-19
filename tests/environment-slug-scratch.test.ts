import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Renaming an environment's URL name against a real Postgres: a throwaway
// database in the local menara-postgres container (superuser password read
// from the container, never printed), migrated with `menara migrate` and
// dropped afterwards. Covers the resolver (current slug, old slug, other
// project), each rename rule, that no environment takes another one's old
// slug, renaming back, who may rename, that aliases go with their
// environment, the activity row, the /resolve endpoint's canonical slug, new
// default slugs skipping aliases, and that the deploy dir, database name,
// domain and variables a deploy uses stay what they were.
//
//   ENVIRONMENT_SLUG_SCRATCH=1 env -u SECRETS_KEY bun --bun vitest run tests/environment-slug-scratch.test.ts
const enabled = process.env.ENVIRONMENT_SLUG_SCRATCH === "1";
const CONTAINER = "menara-postgres";
const DB_NAME = `environment_slug_${randomBytes(4).toString("hex")}`;
process.env.SECRETS_KEY ??= randomBytes(32).toString("base64");

const session = vi.hoisted(() => ({
  user: { id: "", role: "admin", name: "Admin" },
  signInMethod: "passkey",
}));
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));
vi.mock("@/lib/auth-session", () => {
  const current = async () => ({
    user: session.user,
    session: { signInMethod: session.signInMethod },
  });
  return { requireSession: current, getServerSession: current };
});
vi.mock("@/lib/queue", () => ({
  enqueue: vi.fn(),
  scheduleInstanceBackup: vi.fn(async () => {}),
  INSTANCE_BACKUP_MANUAL_JOB_ID: "instance-backup-manual",
}));
vi.mock("@/server/i18n", () => ({
  getServerTranslator: async () => (key: string) => key,
}));

const ADMIN = "00000000-0000-7000-8000-00000000f001";
const ENGINEER = "00000000-0000-7000-8000-00000000f002";
const QA = "00000000-0000-7000-8000-00000000f003";
const OUTSIDER = "00000000-0000-7000-8000-00000000f004";
const PROJECT_A = "00000000-0000-7000-8000-00000000a001";
const PROJECT_B = "00000000-0000-7000-8000-00000000b001";
const ENV_A = "00000000-0000-7000-8000-00000000a0e1";
const ENV_B = "00000000-0000-7000-8000-00000000a0e2";
const ENV_C = "00000000-0000-7000-8000-00000000b0e1";
const SERVER = "00000000-0000-7000-8000-000000000051";
const CI = "00000000-0000-7000-8000-0000000000c1";
const APP = "00000000-0000-7000-8000-0000000000a1";
const TARGET = "00000000-0000-7000-8000-0000000000d1";

const as = (id: string, role: string) => {
  session.user = { id, role, name: role };
};

async function refusal(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    if (error instanceof HTTPException) {
      return { status: error.status, code: (error as { code?: string }).code };
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

async function rootSql() {
  const password = encodeURIComponent(
    execFileSync("podman", ["exec", CONTAINER, "printenv", "POSTGRES_PASSWORD"])
      .toString()
      .trim()
  );
  return {
    base: `postgres://postgres:${password}@127.0.0.1:5432`,
    root: postgres(`postgres://postgres:${password}@127.0.0.1:5432/postgres`, {
      max: 1,
      onnotice: () => {},
    }),
  };
}

describe.skipIf(!enabled)("environment slug renames on Postgres", () => {
  let sql: ReturnType<typeof postgres>;
  let previousUrl: string | undefined;
  let svc: typeof import("@/server/services/environments");
  let resolver: typeof import("@/lib/environment-slug");
  let app: typeof import("@/server/app")["app"];

  const slugOf = async (id: string) =>
    (
      await sql<
        { slug: string }[]
      >`select slug from environments where id = ${id}`
    )[0]?.slug;
  const aliases = async () =>
    (
      await sql<{ project_id: string; slug: string; environment_id: string }[]>`
        select project_id, slug, environment_id from environment_slug_aliases
        order by slug`
    ).map(
      (r) =>
        `${r.project_id === PROJECT_A ? "A" : "B"}:${r.slug}->${r.environment_id}`
    );
  const rename = (id: string, slug: string) =>
    svc.updateEnvironment(id, { slug });

  beforeAll(async () => {
    const { base, root } = await rootSql();
    await root.unsafe(`create database ${DB_NAME}`);
    await root.end();
    const url = `${base}/${DB_NAME}`;
    const result = spawnSync("bun", ["scripts/cli.ts", "migrate"], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        DATABASE_URL: url,
      },
    });
    if (result.status !== 0)
      throw new Error(`migrate failed: ${result.stderr}`);
    previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url;
    sql = postgres(url, { max: 1, onnotice: () => {} });
    for (const [id, name, role] of [
      [ADMIN, "Ayu", "admin"],
      [ENGINEER, "Bima", "engineer"],
      [QA, "Citra", "qa"],
      [OUTSIDER, "Dewo", "engineer"],
    ] as const) {
      await sql`insert into users (id, name, email, role)
        values (${id}, ${name}, ${`${name.toLowerCase()}@example.com`}, ${role})`;
    }
    await sql`insert into projects (id, name, key) values
      (${PROJECT_A}, 'Kestrel', 'KES'), (${PROJECT_B}, 'Heron', 'HER')`;
    // The engineer and the QA work on Kestrel; the outsider on Heron only.
    await sql`insert into project_members (project_id, user_id) values
      (${PROJECT_A}, ${ENGINEER}), (${PROJECT_A}, ${QA}),
      (${PROJECT_B}, ${OUTSIDER})`;
    await sql`insert into servers (id, name, host, username) values
      (${SERVER}, 'Kestrel box', '192.0.2.10', 'deploy')`;
    await sql`insert into ci_connections (id, name, provider, forge, base_url) values
      (${CI}, 'Woodpecker', 'woodpecker', 'bitbucket', 'https://ci.example.invalid')`;
    await sql`insert into apps (id, app_key, name) values (${APP}, 'kestrel', 'Kestrel')`;
    await sql`insert into app_components
      (component_key, app_id, ci_connection_id, repo_full_name, bundle_image, notify_secret, build_spec)
      values ('kestrel-api', ${APP}, ${CI}, 'team/kestrel-api', 'kestrel-api-deploy', 'secret', null)`;
    resolver = await import("@/lib/environment-slug");
    svc = await import("@/server/services/environments");
    ({ app } = await import("@/server/app"));
  });

  afterAll(async () => {
    await sql?.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    if (!enabled) return;
    const { root } = await rootSql();
    await root.unsafe(`drop database if exists ${DB_NAME} with (force)`);
    await root.end();
  });

  beforeEach(async () => {
    await sql`delete from activity_log`;
    await sql`delete from environments`;
    // created_slug as insertEnvironmentIn records it.
    await sql`insert into environments (id, project_id, name, slug, created_slug, app_id, env_file_managed) values
      (${ENV_A}, ${PROJECT_A}, 'Kestrel QA', 'qa', 'qa', ${APP}, true),
      (${ENV_B}, ${PROJECT_A}, 'Kestrel UAT', 'uat', 'uat', null, false),
      (${ENV_C}, ${PROJECT_B}, 'Heron QA', 'qa', 'qa', null, false)`;
    for (const env of [ENV_A, ENV_B, ENV_C]) {
      await sql`insert into environment_services
        (environment_id, role, server_id, service_type, service_name)
        values (${env}, 'backend', ${SERVER}, 'docker', ${`api-${env.slice(-2)}`})`;
    }
    // What setup materialised for Kestrel QA when its slug was `qa`.
    await sql`insert into environment_services
      (environment_id, role, server_id, service_type, service_name, db_type, db_name, db_backup_path)
      values (${ENV_A}, 'db', ${SERVER}, 'docker', 'kes-qa-db-1', 'postgres', 'kes_qa', '/backups/kes-qa')`;
    await sql`insert into deploy_targets
      (id, environment_id, component_key, server_id, source_branch, deploy_dir, services)
      values (${TARGET}, ${ENV_A}, 'kestrel-api', ${SERVER}, 'main', '/deployments/kes-qa', ${["api"]})`;
    await sql`insert into environment_domains (environment_id, kind, hostname)
      values (${ENV_A}, 'external', 'kes-qa.example.test')`;
    await sql`insert into environment_variables (environment_id, name, kind, value)
      values (${ENV_A}, 'COMPOSE_PROJECT_NAME', 'plain', 'kes-qa')`;
    as(ENGINEER, "engineer");
  });

  describe("resolveEnvironmentBySlug", () => {
    it("finds the current slug, case-insensitively", async () => {
      expect(
        await resolver.resolveEnvironmentBySlug(PROJECT_A, "QA")
      ).toMatchObject({
        environment: { id: ENV_A, projectId: PROJECT_A, slug: "qa" },
        canonicalSlug: "qa",
        viaAlias: false,
      });
    });

    it("finds an old slug and names the current one", async () => {
      await rename(ENV_A, "qa-1");
      expect(
        await resolver.resolveEnvironmentBySlug(PROJECT_A, "qa")
      ).toMatchObject({
        environment: { id: ENV_A },
        canonicalSlug: "qa-1",
        viaAlias: true,
      });
      // Heron's own `qa` is another project's: untouched.
      expect(
        await resolver.resolveEnvironmentBySlug(PROJECT_B, "qa")
      ).toMatchObject({ environment: { id: ENV_C }, viaAlias: false });
    });

    it("answers null for a slug the project never used", async () => {
      expect(
        await resolver.resolveEnvironmentBySlug(PROJECT_A, "nope")
      ).toBeNull();
      expect(
        await resolver.resolveEnvironmentBySlug(PROJECT_B, "uat")
      ).toBeNull();
    });
  });

  describe("renaming", () => {
    it("renames, keeps the old slug as an alias and records the change", async () => {
      const result = await rename(ENV_A, "qa-1");
      expect(result).toMatchObject({ success: true, data: { slug: "qa-1" } });
      expect(await slugOf(ENV_A)).toBe("qa-1");
      expect(await aliases()).toEqual([`A:qa->${ENV_A}`]);
      const rows = await sql<
        {
          actor_id: string;
          entity_type: string;
          entity_id: string;
          data: Record<string, string>;
        }[]
      >`select actor_id, entity_type, entity_id, data from activity_log
        where action = 'environment.slugChanged'`;
      expect(rows).toEqual([
        {
          actor_id: ENGINEER,
          entity_type: "environment",
          entity_id: ENV_A,
          data: { environment: "Kestrel QA", from: "qa", to: "qa-1" },
        },
      ]);
    });

    it("refuses each rule with its code and changes nothing", async () => {
      for (const [slug, status, code] of [
        ["", 400, "environmentSlugInvalid"],
        ["QA-1", 400, "environmentSlugInvalid"],
        ["-qa", 400, "environmentSlugInvalid"],
        ["qa-", 400, "environmentSlugInvalid"],
        ["qa--1", 400, "environmentSlugInvalid"],
        ["qa_1", 400, "environmentSlugInvalid"],
        ["x".repeat(41), 400, "environmentSlugInvalid"],
        ["issues", 400, "environmentSlugReserved"],
        ["settings", 400, "environmentSlugReserved"],
        ["uat", 409, "environmentSlugTaken"],
      ] as const) {
        expect(await refusal(rename(ENV_A, slug)), slug).toEqual({
          status,
          code,
        });
      }
      expect(await slugOf(ENV_A)).toBe("qa");
      expect(await aliases()).toEqual([]);
      const logged = await sql`select 1 from activity_log`;
      expect(logged).toHaveLength(0);
    });

    it("accepts 40 characters, and an unchanged slug is no rename", async () => {
      const long = "k".repeat(40);
      expect(await rename(ENV_A, long)).toMatchObject({ success: true });
      expect(await rename(ENV_A, long)).toMatchObject({ success: true });
      expect(await aliases()).toEqual([`A:qa->${ENV_A}`]);
    });

    it("keeps an older slug over 40 characters valid while it is not renamed", async () => {
      const legacy = "kestrel-qa-on-the-old-server-in-the-west-wing";
      await sql`update environments set slug = ${legacy} where id = ${ENV_B}`;
      expect(
        await svc.updateEnvironment(ENV_B, {
          slug: legacy,
          name: "Kestrel UAT 2",
        })
      ).toMatchObject({ success: true });
      expect(await slugOf(ENV_B)).toBe(legacy);
    });

    // Review Focus 2.
    it("never lets another environment take an old slug", async () => {
      await rename(ENV_A, "qa-1");
      expect(await refusal(rename(ENV_B, "qa"))).toEqual({
        status: 409,
        code: "environmentSlugAliasTaken",
      });
      expect(await slugOf(ENV_B)).toBe("uat");
      // Nor its current one.
      expect(await refusal(rename(ENV_B, "qa-1"))).toEqual({
        status: 409,
        code: "environmentSlugTaken",
      });
      // Another project's environment may use it.
      as(ADMIN, "admin");
      await sql`update environments set slug = 'heron-qa' where id = ${ENV_C}`;
      expect(await rename(ENV_C, "qa")).toMatchObject({ success: true });
    });

    it("renaming back reuses the old slug and drops its alias", async () => {
      await rename(ENV_A, "qa-1");
      await rename(ENV_A, "qa-2");
      expect(await aliases()).toEqual([`A:qa->${ENV_A}`, `A:qa-1->${ENV_A}`]);
      expect(await rename(ENV_A, "qa")).toMatchObject({ success: true });
      expect(await slugOf(ENV_A)).toBe("qa");
      expect(await aliases()).toEqual([`A:qa-1->${ENV_A}`, `A:qa-2->${ENV_A}`]);
      expect(
        await resolver.resolveEnvironmentBySlug(PROJECT_A, "qa-2")
      ).toMatchObject({ environment: { id: ENV_A }, canonicalSlug: "qa" });
    });

    // Review Focus 5.
    it("needs environment:update: 403 for a QA member, 404 for an outsider", async () => {
      as(QA, "qa");
      expect(await refusal(rename(ENV_A, "qa-1"))).toMatchObject({
        status: 403,
      });
      as(OUTSIDER, "engineer");
      expect(await refusal(rename(ENV_A, "qa-1"))).toMatchObject({
        status: 404,
      });
      const res = await app.request("/api/environments/update-environment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: ENV_A, data: { slug: "qa-1" } }),
      });
      expect(res.status).toBe(404);
      expect(await slugOf(ENV_A)).toBe("qa");
      expect(await aliases()).toEqual([]);
      expect(await sql`select 1 from activity_log`).toHaveLength(0);
    });

    it("drops an environment's aliases with it, freeing them", async () => {
      await rename(ENV_A, "qa-1");
      await sql`delete from environments where id = ${ENV_A}`;
      expect(await aliases()).toEqual([]);
      expect(await rename(ENV_B, "qa")).toMatchObject({ success: true });
    });

    it("refuses a move into a project where the slug is another environment's old one", async () => {
      as(ADMIN, "admin");
      await rename(ENV_C, "heron-qa");
      // Kestrel QA (`qa`) into Heron, where `qa` is Heron QA's old slug.
      expect(
        await refusal(svc.updateEnvironment(ENV_A, { projectId: PROJECT_B }))
      ).toEqual({ status: 409, code: "environmentSlugAliasTaken" });
    });
  });

  describe("moving to another project", () => {
    // A move keeps the slug but changes its namespace: /KES/qa must keep
    // opening the environment, now at /HER/qa.
    it("keeps the old project's slug as an alias, so its links follow the move", async () => {
      as(ADMIN, "admin");
      await rename(ENV_C, "heron-qa");
      expect(
        await svc.updateEnvironment(ENV_B, { projectId: PROJECT_B })
      ).toMatchObject({ success: true });
      expect(await aliases()).toContain(`A:uat->${ENV_B}`);
      const res = await app.request(
        "/api/environments/resolve?projectKey=KES&envSlug=uat"
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        environmentId: ENV_B,
        projectKey: "HER",
        envSlug: "uat",
      });
      // Kestrel can't give `uat` to another environment.
      expect(await refusal(rename(ENV_A, "uat"))).toEqual({
        status: 409,
        code: "environmentSlugAliasTaken",
      });
      expect(await svc.uniqueEnvSlug(PROJECT_A, "UAT")).toBe("uat-2");
    });

    it("moving back makes the slug current again and drops its alias", async () => {
      as(ADMIN, "admin");
      await svc.updateEnvironment(ENV_B, { projectId: PROJECT_B });
      await svc.updateEnvironment(ENV_B, { projectId: PROJECT_A });
      expect(await aliases()).toEqual([`B:uat->${ENV_B}`]);
      expect(
        await resolver.resolveEnvironmentBySlug(PROJECT_A, "uat")
      ).toMatchObject({ environment: { id: ENV_B }, viaAlias: false });
    });
  });

  describe("/resolve", () => {
    it("opens an old slug and answers the current one", async () => {
      await rename(ENV_A, "qa-1");
      const res = await app.request(
        "/api/environments/resolve?projectKey=kes&envSlug=qa"
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        environmentId: ENV_A,
        role: "engineer",
        projectKey: "KES",
        envSlug: "qa-1",
      });
      // An outsider still gets 404, old slug or not.
      as(OUTSIDER, "engineer");
      const hidden = await app.request(
        "/api/environments/resolve?projectKey=KES&envSlug=qa"
      );
      expect(hidden.status).toBe(404);
    });
  });

  describe("races", () => {
    // Both read the slug `qa` before either commits; the second renames the
    // slug the row has under the lock (qa-1 or qa-2), not the stale `qa`.
    it("two renames of one environment both land, each old slug an alias", async () => {
      const results = await Promise.all([
        rename(ENV_A, "qa-1"),
        rename(ENV_A, "qa-2"),
      ]);
      expect(results).toMatchObject([{ success: true }, { success: true }]);
      const final = await slugOf(ENV_A);
      const between = final === "qa-1" ? "qa-2" : "qa-1";
      expect(await aliases()).toEqual([
        `A:qa->${ENV_A}`,
        `A:${between}->${ENV_A}`,
      ]);
      const changes = await sql<{ data: { from: string; to: string } }[]>`
        select data from activity_log where action = 'environment.slugChanged'
        order by created_at`;
      expect(changes.map((r) => `${r.data.from}>${r.data.to}`)).toEqual([
        `qa>${between}`,
        `${between}>${final}`,
      ]);
    });

    it("two environments racing for one slug: one wins, the other gets the coded 409", async () => {
      const outcomes = await Promise.all(
        [ENV_A, ENV_B].map((id) =>
          rename(id, "shared").then(
            () => "renamed",
            (error) =>
              error instanceof HTTPException
                ? `${error.status} ${(error as { code?: string }).code}`
                : String(error)
          )
        )
      );
      expect(outcomes.sort()).toEqual(["409 environmentSlugTaken", "renamed"]);
    });
  });

  describe("applyTemplate", () => {
    const stackName = async (renames: string[]) => {
      await sql`delete from app_variable_templates`;
      await sql`delete from environment_variables
        where environment_id = ${ENV_A} and name = 'STACK_NAME'`;
      await sql`insert into app_variable_templates (app_id, name, kind, default_value)
        values (${APP}, 'STACK_NAME', 'plain', 'kes-{envSlug}')`;
      for (const slug of renames) await rename(ENV_A, slug);
      const { applyTemplate } = await import("@/server/services/variables");
      expect(await applyTemplate(ENV_A)).toMatchObject({
        added: ["STACK_NAME"],
      });
      const [row] = await sql<{ value: string }[]>`
        select value from environment_variables
        where environment_id = ${ENV_A} and name = 'STACK_NAME'`;
      await sql`delete from app_variable_templates`;
      return row?.value;
    };

    it("fills {envSlug} with the slug the environment was created with", async () => {
      expect(await stackName(["qa-1", "qa-2"])).toBe("kes-qa");
    });

    // Renaming back drops the alias of the slug it was created with: the
    // created slug is its own column, not the oldest alias.
    it("keeps the created slug after renaming away and back (a→b→a)", async () => {
      expect(await stackName(["qa-1", "qa"])).toBe("kes-qa");
      expect(await aliases()).toEqual([`A:qa-1->${ENV_A}`]);
    });

    it("keeps the created slug after a→b→c→a", async () => {
      expect(await stackName(["qa-1", "qa-2", "qa"])).toBe("kes-qa");
    });

    it("keeps the created slug when a rename back lands on a later slug (a→b→a→c)", async () => {
      expect(await stackName(["qa-1", "qa", "qa-3"])).toBe("kes-qa");
    });

    it("uses the current slug of an environment never renamed", async () => {
      await sql`delete from app_variable_templates`;
      await sql`insert into app_variable_templates (app_id, name, kind, default_value)
        values (${APP}, 'STACK_NAME', 'plain', 'kes-{envSlug}')`;
      const { applyTemplate } = await import("@/server/services/variables");
      await applyTemplate(ENV_A);
      const [row] = await sql<{ value: string }[]>`
        select value from environment_variables
        where environment_id = ${ENV_A} and name = 'STACK_NAME'`;
      expect(row?.value).toBe("kes-qa");
      await sql`delete from app_variable_templates`;
    });
  });

  describe("/check-slug", () => {
    const check = async (slug: string, environmentId?: string) => {
      const res = await app.request(
        `/api/environments/check-slug?projectId=${PROJECT_A}&slug=${encodeURIComponent(slug)}${environmentId ? `&environmentId=${environmentId}` : ""}`
      );
      return { status: res.status, body: await res.json() };
    };

    it("answers each rule's code, and null for a free slug", async () => {
      await rename(ENV_A, "qa-1");
      expect((await check("kes-west")).body).toEqual({ code: null });
      expect((await check("uat")).body).toEqual({
        code: "environmentSlugTaken",
      });
      expect((await check("qa")).body).toEqual({
        code: "environmentSlugAliasTaken",
      });
      // The environment's own old slug is free for it.
      expect((await check("qa", ENV_A)).body).toEqual({ code: null });
      expect((await check("issues")).body).toEqual({
        code: "environmentSlugReserved",
      });
      expect((await check("Kes_West")).body).toEqual({
        code: "environmentSlugInvalid",
      });
    });

    it("is 404 for a caller who can't see the project", async () => {
      as(OUTSIDER, "engineer");
      expect((await check("kes-west")).status).toBe(404);
    });
  });

  describe("a new environment's chosen URL name", () => {
    const input = (slug: string) => ({
      projectId: PROJECT_A,
      appId: APP,
      name: "Kestrel West",
      slug,
      server: { serverId: SERVER },
      targets: [
        {
          componentKey: "kestrel-api",
          sourceBranch: "main",
          deployDir: "/deployments/kes-west",
          services: ["api"],
        },
      ],
      services: [{ role: "backend", serviceName: "kes-west-api-1" }],
      database: { kind: "none" },
      domain: { kind: "none" },
    });

    it("is refused at `slug` when another environment had it", async () => {
      as(ADMIN, "admin");
      await rename(ENV_A, "qa-1");
      const { environmentSetupInputSchema } = await import(
        "@/lib/setup/schema"
      );
      const setup = await import("@/server/services/environment-setup");
      const preview = await setup.previewEnvironmentSetup(
        environmentSetupInputSchema.parse(input("qa"))
      );
      expect(preview.issues).toContainEqual({
        field: "slug",
        code: "environmentSlugAliasTaken",
      });
      expect(
        await refusal(
          setup.createEnvironmentSetup(
            environmentSetupInputSchema.parse(input("qa"))
          )
        )
      ).toEqual({ status: 409, code: "environmentSlugAliasTaken" });
    });

    it("is the new environment's slug when free", async () => {
      as(ADMIN, "admin");
      const { environmentSetupInputSchema } = await import(
        "@/lib/setup/schema"
      );
      const setup = await import("@/server/services/environment-setup");
      const created = await setup.createEnvironmentSetup(
        environmentSetupInputSchema.parse(input("kes-west"))
      );
      expect(created.envSlug).toBe("kes-west");
      expect(await slugOf(created.environmentId)).toBe("kes-west");
      const [row] = await sql<{ created_slug: string | null }[]>`
        select created_slug from environments where id = ${created.environmentId}`;
      expect(row?.created_slug).toBe("kes-west");
    });
  });

  describe("uniqueEnvSlug", () => {
    it("skips current and old slugs and stays within 40 characters", async () => {
      await rename(ENV_A, "qa-1");
      expect(await svc.uniqueEnvSlug(PROJECT_A, "QA")).toBe("qa-2");
      expect(await svc.uniqueEnvSlug(PROJECT_A, "UAT")).toBe("uat-2");
      const long = "w".repeat(40);
      await rename(ENV_B, long);
      const next = await svc.uniqueEnvSlug(PROJECT_A, "W".repeat(60));
      expect(next).toBe(`${"w".repeat(38)}-2`);
      expect(await svc.uniqueEnvSlug(PROJECT_A, "Issues")).toBe("issues-2");
    });
  });

  // Review Focus 3: what the next deploy acts on is stored, not derived.
  describe("materialised names", () => {
    it("the next deploy uses the same dir, database, domain and variables", async () => {
      const { getTarget } = await import("@/lib/deploy/repository");
      const { loadEnvironmentWithServers } = await import("@/lib/environments");
      const { getDomain } = await import("@/lib/domains/repository");
      const { loadManagedEnvFileVariables } = await import(
        "@/lib/variables/managed-env"
      );
      const snapshot = async () => {
        const env = await loadEnvironmentWithServers(ENV_A);
        const db = env?.services.find((s) => s.role === "db");
        return {
          deployDir: (await getTarget(TARGET))?.deployDir,
          dbName: db?.dbName,
          dbContainer: db?.serviceName,
          dbBackupPath: db?.dbBackupPath,
          hostname: (await getDomain(ENV_A))?.hostname,
          variables: await loadManagedEnvFileVariables(ENV_A),
        };
      };
      const before = await snapshot();
      expect(before).toMatchObject({
        deployDir: "/deployments/kes-qa",
        dbName: "kes_qa",
        hostname: "kes-qa.example.test",
      });
      await rename(ENV_A, "kestrel-qa");
      expect(await snapshot()).toEqual(before);
    });
  });
});
