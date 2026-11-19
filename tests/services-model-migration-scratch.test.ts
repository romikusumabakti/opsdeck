import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The services-model migration on real rows: throwaway databases made in the
// local menara-postgres container (superuser password read from the
// container, never printed) and dropped afterwards. Every migration before
// 20261130000000_services_model runs first, the fixtures go in, then the real
// drizzle/ folder runs the services-model migration and its backfills.
//
//   SERVICES_MODEL_SCRATCH=1 env -u SECRETS_KEY bun --bun vitest run tests/services-model-migration-scratch.test.ts
const enabled = process.env.SERVICES_MODEL_SCRATCH === "1";
const MIGRATION = "20261130000000_services_model";

const suffix = randomBytes(4).toString("hex");
const dbName = `services_model_${suffix}`;
const emptyDbName = `services_model_empty_${suffix}`;
const password = enabled
  ? encodeURIComponent(
      execFileSync("podman", [
        "exec",
        "menara-postgres",
        "printenv",
        "POSTGRES_PASSWORD",
      ])
        .toString()
        .trim()
    )
  : "";
const base = `postgres://postgres:${password}@127.0.0.1:5432`;
// lib/db connects lazily, so code under test imported by later cases hits the
// scratch database.
if (enabled) process.env.DATABASE_URL = `${base}/${dbName}`;

const id = (n: number) =>
  `019a0000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const P1 = id(1);
const P2 = id(2);
const P3 = id(3);
const P4 = id(4);
const P5 = id(5);
const APP_A = id(11);
const APP_B = id(12);
const APP_C = id(13);
const APP_D = id(14);
const E2 = id(22);
const E3 = id(23);
const E5 = id(25);
const CI = id(31);
const SERVER = id(32);

describe.skipIf(!enabled)("services model migration on a real Postgres", () => {
  const admin = postgres(`${base}/postgres`, { max: 1, onnotice: () => {} });
  let sql: ReturnType<typeof postgres>;
  let before: string | undefined;

  const servicesOf = async (project: string) =>
    (
      await sql`select component_key from project_services
      where project_id = ${project} order by component_key`
    ).map((row) => row.component_key as string);
  const allProjectServices = () =>
    sql`select project_id, component_key, created_at from project_services
    order by project_id, component_key`;
  const allTemplates = () =>
    sql`select component_key, name, kind, required, default_value,
      generated_length, escrow, description, created_at, updated_at
    from service_variable_templates order by component_key, name`;
  const component = (key: string, app: string | null) =>
    sql`insert into app_components
    (component_key, app_id, ci_connection_id, repo_full_name, bundle_image, notify_secret, build_spec)
    values (${key}, ${app}, ${CI}, ${`team/${key}`}, ${`${key}-deploy`}, 'secret', null)`;
  const target = (environment: string, componentKey: string) =>
    sql`insert into deploy_targets
    (environment_id, component_key, server_id, source_branch, deploy_dir, services)
    values (${environment}, ${componentKey}, ${SERVER}, 'main', '/srv/app', ${["app"]})`;

  beforeAll(async () => {
    await admin.unsafe(`create database ${dbName}`);
    await admin.unsafe(`create database ${emptyDbName}`);
    sql = postgres(`${base}/${dbName}`, {
      max: 2,
      onnotice: () => {},
      connection: { TimeZone: "UTC" },
    });
    const db = drizzle({ client: sql });

    // The schema as the previous release left it.
    before = mkdtempSync(join(tmpdir(), "menara-services-model-"));
    for (const entry of readdirSync("drizzle")) {
      if (entry >= MIGRATION) continue;
      cpSync(join("drizzle", entry), join(before, entry), { recursive: true });
    }
    await migrate(db, { migrationsFolder: before });

    await sql`insert into ci_connections (id, name, provider, forge, base_url) values
    (${CI}, 'Woodpecker', 'woodpecker', 'bitbucket', 'https://ci.example.invalid')`;
    await sql`insert into servers (id, name, host, username) values
    (${SERVER}, 'Server', '192.0.2.1', 'deploy')`;
    await sql`insert into apps (id, app_key, name) values
    (${APP_A}, 'core', 'Core'), (${APP_B}, 'cms', 'CMS'),
    (${APP_C}, 'portal', 'Portal'), (${APP_D}, 'docs', 'Docs')`;
    await component("core-backend", APP_A);
    await component("core-frontend", APP_A);
    await component("cms-web", APP_B);
    await component("portal-api", APP_C);
    await component("docs-site", APP_D);
    await sql`insert into projects (id, name, key) values
    (${P1}, 'Project one', 'P1'), (${P2}, 'Project two', 'P2'),
    (${P3}, 'Project three', 'P3'), (${P4}, 'Project four', 'P4'),
    (${P5}, 'Project five', 'P5')`;
    // P1: linked to the two-component app, no environment.
    await sql`insert into project_apps (project_id, app_id) values (${P1}, ${APP_A})`;
    // P2: an environment on app B with no project_apps row (written by the
    // previous release during a rollback window).
    // P3: an app-less environment with a target.
    // P5: an app B environment that targets one component of app A.
    for (const [environment, project, app] of [
      [E2, P2, APP_B],
      [E3, P3, null],
      [E5, P5, APP_B],
    ] as const) {
      await sql`insert into environments (id, project_id, name, slug, app_id)
      values (${environment}, ${project}, ${`env ${environment}`},
        ${`env-${environment}`}, ${app})`;
    }
    await target(E3, "portal-api");
    await target(E5, "core-backend");
    await sql`insert into app_variable_templates
    (app_id, name, kind, required, default_value, generated_length, escrow, description)
    values
    (${APP_A}, 'DB_PASSWORD', 'generated', true, null, 48, true, 'Database password'),
    (${APP_A}, 'API_URL', 'plain', false, '{url}/api', null, false, null),
    (${APP_B}, 'SITE_NAME', 'plain', true, 'Kestrel', null, false, 'Shown in the header')`;

    await migrate(db, { migrationsFolder: "drizzle" });
  });

  afterAll(async () => {
    if (before) rmSync(before, { recursive: true, force: true });
    await sql?.end();
    await admin.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin.unsafe(`drop database if exists ${emptyDbName} with (force)`);
    await admin.end();
  });

  it("a project linked to a two-component app gets both services", async () => {
    expect(await servicesOf(P1)).toEqual(["core-backend", "core-frontend"]);
  });

  it("an environment's app without a project_apps row still yields its services", async () => {
    expect(await servicesOf(P2)).toEqual(["cms-web"]);
  });

  it("a target's service is covered, even on an app-less environment", async () => {
    expect(await servicesOf(P3)).toEqual(["portal-api"]);
  });

  it("a cross-app target adds only the targeted service of the other app", async () => {
    expect(await servicesOf(P5)).toEqual(["cms-web", "core-backend"]);
  });

  it("a project with no app and no target gets nothing", async () => {
    expect(await servicesOf(P4)).toEqual([]);
  });

  it("copies each app template to every component of its app", async () => {
    const rows = await allTemplates();
    expect(
      rows.map((row) => ({
        component_key: row.component_key,
        name: row.name,
        kind: row.kind,
        required: row.required,
        default_value: row.default_value,
        generated_length: row.generated_length,
        escrow: row.escrow,
        description: row.description,
      }))
    ).toEqual([
      {
        component_key: "cms-web",
        name: "SITE_NAME",
        kind: "plain",
        required: true,
        default_value: "Kestrel",
        generated_length: null,
        escrow: false,
        description: "Shown in the header",
      },
      ...["core-backend", "core-frontend"].flatMap((key) => [
        {
          component_key: key,
          name: "API_URL",
          kind: "plain",
          required: false,
          default_value: "{url}/api",
          generated_length: null,
          escrow: false,
          description: null,
        },
        {
          component_key: key,
          name: "DB_PASSWORD",
          kind: "generated",
          required: true,
          default_value: null,
          generated_length: 48,
          escrow: true,
          description: "Database password",
        },
      ]),
    ]);
  });

  it("backfill writes no activity rows", async () => {
    const [row] = await sql`select count(*)::int as n from activity_log`;
    expect(row?.n).toBe(0);
  });

  // A replay (a re-run by hand, a restore) must never duplicate a row nor
  // overwrite a template someone edited.
  it("replaying the backfills changes nothing, even after a hand edit", async () => {
    const statements = readFileSync(
      join("drizzle", MIGRATION, "migration.sql"),
      "utf8"
    )
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim());
    const inserts = statements.filter((s) => s.includes("INSERT INTO"));
    expect(inserts).toHaveLength(2);

    await sql`update service_variable_templates set description = 'hand-edited'
    where component_key = 'core-frontend' and name = 'API_URL'`;
    const servicesBefore = await allProjectServices();
    const templatesBefore = await allTemplates();

    for (const insert of inserts) await sql.unsafe(insert);

    expect(await allProjectServices()).toEqual(servicesBefore);
    expect(await allTemplates()).toEqual(templatesBefore);
  });

  it("registers a service without an app", async () => {
    await component("solo-worker", null);
    const [row] = await sql`select app_id from app_components
    where component_key = 'solo-worker'`;
    expect(row?.app_id).toBeNull();
  });

  // The previous release still runs on this schema (update.sh rolls back to
  // it): its app, environment, template and target writes keep working.
  it("the previous release's writes keep working", async () => {
    await component("docs-api", APP_D);
    await sql`insert into project_apps (project_id, app_id) values (${P4}, ${APP_D})`;
    const e = id(27);
    await sql`insert into environments (id, project_id, name, slug, app_id)
    values (${e}, ${P4}, 'Rollback env', 'rollback-env', ${APP_D})`;
    await target(e, "docs-api");
    await sql`insert into app_variable_templates (app_id, name, kind)
    values (${APP_D}, 'DOCS_TOKEN', 'secret')`;
    // No dual write: nothing reaches the new tables.
    expect(await servicesOf(P4)).toEqual([]);
    const rows = await sql`select 1 from service_variable_templates
    where component_key like 'docs-%'`;
    expect(rows).toHaveLength(0);
  });

  it("a component a project uses can't be deleted; its templates cascade", async () => {
    await expect(
      sql`delete from app_components where component_key = 'core-frontend'`
    ).rejects.toThrow(/project_services_component_key_fk/);
    await component("temp-svc", null);
    await sql`insert into service_variable_templates (component_key, name, kind)
    values ('temp-svc', 'X', 'plain')`;
    await sql`delete from app_components where component_key = 'temp-svc'`;
    const rows = await sql`select 1 from service_variable_templates
    where component_key = 'temp-svc'`;
    expect(rows).toHaveLength(0);
  });

  it("runs on an empty database", async () => {
    const empty = postgres(`${base}/${emptyDbName}`, {
      max: 1,
      onnotice: () => {},
    });
    try {
      await migrate(drizzle({ client: empty }), {
        migrationsFolder: "drizzle",
      });
      const [counts] = await empty`select
        (select count(*)::int from project_services) as services,
        (select count(*)::int from service_variable_templates) as templates`;
      expect(counts).toEqual({ services: 0, templates: 0 });
    } finally {
      await empty.end();
    }
  });

  // The naming layer, on the rows above.
  describe("lib/service-catalog", () => {
    type Catalog = typeof import("@/lib/service-catalog");
    let catalog: Catalog;

    beforeAll(async () => {
      // DATABASE_URL is set at module load, so this hits the scratch database.
      catalog = await import("@/lib/service-catalog");
    });

    it("getService returns the service without its notify secret", async () => {
      const service = await catalog.getService("core-backend");
      expect(service).toMatchObject({
        key: "core-backend",
        repoFullName: "team/core-backend",
        ciConnectionId: CI,
        bundleImage: "core-backend-deploy",
        notifySecretName: "menara_notify",
        pipelineMode: "custom",
      });
      expect(service).not.toHaveProperty("notifySecret");
      expect(service).not.toHaveProperty("appId");
      expect(await catalog.getService("nope")).toBeNull();
    });

    it("listServices lists every service by key, app or not", async () => {
      const keys = (await catalog.listServices()).map((s) => s.key);
      expect(keys).toEqual([...keys].sort());
      expect(keys).toEqual(
        expect.arrayContaining(["core-backend", "solo-worker", "docs-site"])
      );
    });

    it("listProjectServices lists the project's services by key", async () => {
      expect((await catalog.listProjectServices(P5)).map((s) => s.key)).toEqual(
        ["cms-web", "core-backend"]
      );
      expect(await catalog.listProjectServices(P4)).toEqual([]);
    });

    it("isProjectService checks membership", async () => {
      expect(await catalog.isProjectService(P1, "core-frontend")).toBe(true);
      expect(await catalog.isProjectService(P1, "cms-web")).toBe(false);
      expect(await catalog.isProjectService(P1, "nope")).toBe(false);
    });
  });
});
