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

// The project-sources migration on real rows: a throwaway database made in the
// local opsdeck-postgres container (superuser password read from the
// container, never printed) and dropped afterwards. Every migration before
// 20261118000000_project_sources runs first, the fixtures go in, then the real
// drizzle/ folder runs the project-sources migration and its backfill.
//
//   PROJECT_SOURCES_SCRATCH=1 env -u SECRETS_KEY bun --bun vitest run tests/project-sources-migration-scratch.test.ts
const enabled = process.env.PROJECT_SOURCES_SCRATCH === "1";
const MIGRATION = "20261118000000_project_sources";

const dbName = `project_sources_${randomBytes(4).toString("hex")}`;
const password = enabled
  ? encodeURIComponent(
      execFileSync("podman", [
        "exec",
        "opsdeck-postgres",
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

// Fixed, ascending uuidv7 ids, so "the newest environment" is deterministic.
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
const E1 = id(21);
const E2 = id(22);
const E3 = id(23);
const E4 = id(24);
const E5 = id(25);
const E6 = id(26);
const E7 = id(29);
const E8 = id(28);
const USER = id(41);
const CI = id(31);
const SERVER = id(32);

describe.skipIf(!enabled)(
  "project sources migration on a real Postgres",
  () => {
    const admin = postgres(`${base}/postgres`, { max: 1, onnotice: () => {} });
    let sql: ReturnType<typeof postgres>;
    let before: string | undefined;

    const projectApps = () =>
      sql`select project_id, app_id from project_apps order by project_id, app_id`;
    const projectBranches = () =>
      sql`select project_id, component_key, branch from project_component_branches
      order by project_id, component_key`;
    const branchOf = async (project: string, component: string) => {
      const [row] = await sql`select branch from project_component_branches
      where project_id = ${project} and component_key = ${component}`;
      return row?.branch;
    };
    const hasApp = async (project: string, app: string) => {
      const rows = await sql`select 1 from project_apps
      where project_id = ${project} and app_id = ${app}`;
      return rows.length === 1;
    };
    const target = (environment: string, component: string, branch: string) =>
      sql`insert into deploy_targets
      (environment_id, component_key, server_id, source_branch, deploy_dir, services)
      values (${environment}, ${component}, ${SERVER}, ${branch}, '/srv/app', ${["app"]})`;

    beforeAll(async () => {
      await admin.unsafe(`create database ${dbName}`);
      sql = postgres(`${base}/${dbName}`, {
        max: 2,
        onnotice: () => {},
        connection: { TimeZone: "UTC" },
      });
      const db = drizzle({ client: sql });

      // The schema as the previous release left it.
      before = mkdtempSync(join(tmpdir(), "opsdeck-project-sources-"));
      for (const entry of readdirSync("drizzle")) {
        if (entry === MIGRATION) continue;
        cpSync(join("drizzle", entry), join(before, entry), {
          recursive: true,
        });
      }
      await migrate(db, { migrationsFolder: before });

      await sql`insert into ci_connections (id, name, provider, forge, base_url) values
      (${CI}, 'Woodpecker', 'woodpecker', 'bitbucket', 'https://ci.example.invalid')`;
      await sql`insert into servers (id, name, host, username) values
      (${SERVER}, 'Server', '192.0.2.1', 'deploy')`;
      await sql`insert into apps (id, app_key, name) values
      (${APP_A}, 'core', 'Core'), (${APP_B}, 'cms', 'CMS'),
      (${APP_C}, 'portal', 'Portal')`;
      for (const [component, app] of [
        ["core-backend", APP_A],
        ["core-frontend", APP_A],
        ["cms-web", APP_B],
        ["portal-api", APP_C],
      ] as const) {
        await sql`insert into app_components
        (component_key, app_id, ci_connection_id, repo_full_name, bundle_image, notify_secret, build_spec)
        values (${component}, ${app}, ${CI}, ${`team/${component}`},
          ${`${component}-deploy`}, 'secret', null)`;
      }
      await sql`insert into projects (id, name, key) values
      (${P1}, 'Project one', 'P1'), (${P2}, 'Project two', 'P2'),
      (${P3}, 'Project three', 'P3'), (${P4}, 'Project four', 'P4'),
      (${P5}, 'Project five', 'P5')`;
      for (const [environment, project, app] of [
        [E1, P1, APP_A],
        [E2, P1, APP_A],
        [E3, P1, APP_A],
        [E4, P2, null],
        [E5, P3, null],
        [E6, P4, APP_B],
        [E8, P5, APP_B],
      ] as const) {
        await sql`insert into environments (id, project_id, name, slug, app_id)
        values (${environment}, ${project}, ${`env ${environment}`},
          ${`env-${environment}`}, ${app})`;
      }
      await target(E1, "core-backend", "kestrel/development");
      await target(E2, "core-backend", "kestrel/development");
      await target(E3, "core-backend", "kestrel/demo");
      await target(E1, "core-frontend", "fe-a");
      await target(E3, "core-frontend", "fe-b");
      await target(E4, "portal-api", "main");
      // A target of an app A component on an app B environment.
      await target(E8, "core-backend", "p5-branch");

      await migrate(db, { migrationsFolder: "drizzle" });
    });

    afterAll(async () => {
      if (before) rmSync(before, { recursive: true, force: true });
      await sql?.end();
      await admin.unsafe(`drop database if exists ${dbName} with (force)`);
      await admin.end();
    });

    it("the most used branch wins", async () => {
      expect(await branchOf(P1, "core-backend")).toBe("kestrel/development");
    });

    it("a tie goes to the newest environment", async () => {
      expect(await branchOf(P1, "core-frontend")).toBe("fe-b");
    });

    it("an app-less environment with targets is covered", async () => {
      expect(await hasApp(P2, APP_C)).toBe(true);
      expect(await branchOf(P2, "portal-api")).toBe("main");
    });

    it("a target's app is covered even when its environment is on another app", async () => {
      expect(await hasApp(P5, APP_A)).toBe(true);
      expect(await hasApp(P5, APP_B)).toBe(true);
    });

    it("an environment without targets gives its app and no branch", async () => {
      expect(await hasApp(P4, APP_B)).toBe(true);
      const rows =
        await sql`select 1 from project_component_branches where project_id = ${P4}`;
      expect(rows).toHaveLength(0);
    });

    it("a project with no app and no target gets nothing", async () => {
      const apps =
        await sql`select 1 from project_apps where project_id = ${P3}`;
      const branches =
        await sql`select 1 from project_component_branches where project_id = ${P3}`;
      expect(apps).toHaveLength(0);
      expect(branches).toHaveLength(0);
    });

    it("backfill writes no activity rows", async () => {
      const [row] = await sql`select count(*)::int as n from activity_log`;
      expect(row?.n).toBe(0);
    });

    // A replay (a re-run by hand, a restore) must never overwrite a default
    // someone edited, nor re-pick one the targets would now choose differently.
    it("replaying the backfill changes nothing, even after a hand edit", async () => {
      const statements = readFileSync(
        join("drizzle", MIGRATION, "migration.sql"),
        "utf8"
      )
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim());
      const appsInsert = statements.find((s) =>
        s.startsWith('INSERT INTO "project_apps"')
      );
      const branchesInsert = statements.find((s) =>
        s.startsWith('INSERT INTO "project_component_branches"')
      );
      if (!appsInsert || !branchesInsert)
        throw new Error("no backfill INSERT in the migration");

      await sql`update project_component_branches set branch = 'hand-edited'
      where project_id = ${P1} and component_key = 'core-backend'`;
      // fe-a would now win the count for (P1, core-frontend).
      await target(E2, "core-frontend", "fe-a");
      const appsBefore = await projectApps();
      const branchesBefore = await projectBranches();

      await sql.unsafe(appsInsert);
      await sql.unsafe(branchesInsert);

      expect(await projectApps()).toEqual(appsBefore);
      expect(await projectBranches()).toEqual(branchesBefore);
      expect(await branchOf(P1, "core-backend")).toBe("hand-edited");
      expect(await branchOf(P1, "core-frontend")).toBe("fe-b");
    });

    // The previous release still runs on this schema (update.sh rolls back to
    // it): its environment and target writes must keep working, and it never
    // writes a source row.
    it("the previous release's environment and target writes keep working", async () => {
      const appsBefore = await projectApps();
      const branchesBefore = await projectBranches();
      const e7 = id(27);
      await sql`insert into environments (id, project_id, name, slug, app_id)
      values (${e7}, ${P4}, 'Rollback env', 'rollback-env', ${APP_B})`;
      await target(e7, "cms-web", "release");
      expect(await projectApps()).toEqual(appsBefore);
      expect(await projectBranches()).toEqual(branchesBefore);
    });

    // The data layer, on the rows above. The cases run in order: each one
    // leaves P3 / P4 as the next expects.
    describe("lib/project-sources", () => {
      type Sources = typeof import("@/lib/project-sources");
      let sources: Sources;
      let appDb: typeof import("@/lib/db").db;

      beforeAll(async () => {
        // DATABASE_URL is set at module load, so these hit the scratch database.
        sources = await import("@/lib/project-sources");
        appDb = (await import("@/lib/db")).db;
        await sql`insert into users (id, name, email) values
        (${USER}, 'Engineer', 'engineer@example.invalid')`;
      });

      it("lists an app only the environments name (no project_apps row)", async () => {
        // As the previous release would: an environment, no helper.
        await sql`insert into environments (id, project_id, name, slug, app_id)
        values (${E7}, ${P3}, 'Legacy env', 'legacy-env', ${APP_A})`;
        expect(await hasApp(P3, APP_A)).toBe(false);

        expect(await sources.projectSourceAppIds(P3)).toContain(APP_A);
        const listed = await sources.loadProjectSources(P3);
        const app = listed.find((source) => source.appId === APP_A);
        expect(app?.inUse).toBe(true);
        expect(app?.components.map((c) => c.componentKey)).toEqual([
          "core-backend",
          "core-frontend",
        ]);
        for (const component of app?.components ?? []) {
          expect(component.environments).toEqual([
            {
              id: E7,
              name: "Legacy env",
              slug: "legacy-env",
              sourceBranch: null,
            },
          ]);
        }
      });

      it("lists an app used only through a target, with its default", async () => {
        expect(await sources.loadProjectSources(P2)).toEqual([
          {
            appId: APP_C,
            appKey: "portal",
            name: "Portal",
            inUse: true,
            components: [
              {
                componentKey: "portal-api",
                repoFullName: "team/portal-api",
                defaultBranch: "main",
                fallbackBranch: "main",
                environments: [
                  {
                    id: E4,
                    name: `env ${E4}`,
                    slug: `env-${E4}`,
                    sourceBranch: "main",
                  },
                ],
              },
            ],
          },
        ]);
      });

      it("a source no environment uses is not in use", async () => {
        expect(await sources.insertProjectApp(P3, APP_B)).toBe(true);
        expect(await sources.insertProjectApp(P3, APP_B)).toBe(false);
        const listed = await sources.loadProjectSources(P3);
        expect(listed.find((source) => source.appId === APP_B)).toEqual({
          appId: APP_B,
          appKey: "cms",
          name: "CMS",
          inUse: false,
          components: [
            {
              componentKey: "cms-web",
              repoFullName: "team/cms-web",
              defaultBranch: null,
              fallbackBranch: "main",
              environments: [],
            },
          ],
        });
      });

      it("deleteProjectApp refuses an app used only through a target", async () => {
        expect(await sources.deleteProjectApp(P2, APP_C)).toBe("inUse");
        expect(await hasApp(P2, APP_C)).toBe(true);
        expect(await branchOf(P2, "portal-api")).toBe("main");
      });

      it("deleteProjectApp removes the app and its components' defaults", async () => {
        await sources.upsertComponentBranch({
          projectId: P3,
          componentKey: "cms-web",
          branch: "dev",
          userId: USER,
        });
        expect(await sources.deleteProjectApp(P3, APP_B)).toBe("deleted");
        expect(await hasApp(P3, APP_B)).toBe(false);
        expect(await branchOf(P3, "cms-web")).toBeUndefined();
        expect(await sources.deleteProjectApp(P3, APP_B)).toBe("absent");
      });

      it("upsertComponentBranch replaces the value and stamps the editor", async () => {
        await sources.upsertComponentBranch({
          projectId: P4,
          componentKey: "cms-web",
          branch: "first",
          userId: USER,
        });
        await sources.upsertComponentBranch({
          projectId: P4,
          componentKey: "cms-web",
          branch: "second",
          userId: USER,
        });
        const [row] =
          await sql`select branch, updated_by from project_component_branches
        where project_id = ${P4} and component_key = 'cms-web'`;
        expect(row).toEqual({ branch: "second", updated_by: USER });
        expect(await sources.getComponentBranch(P4, "cms-web")).toBe("second");
        expect(await sources.getComponentBranch(P4, "nope")).toBeNull();
      });

      it("seeding keeps the first branch", async () => {
        await sources.recordTargetSourceIn(appDb, {
          environmentId: E5,
          componentKey: "core-backend",
          sourceBranch: "x",
        });
        await sources.recordTargetSourceIn(appDb, {
          environmentId: E5,
          componentKey: "core-backend",
          sourceBranch: "y",
        });
        expect(await branchOf(P3, "core-backend")).toBe("x");
        expect(await hasApp(P3, APP_A)).toBe(true);
      });

      it("ensureProjectSourceIn is idempotent", async () => {
        await sources.ensureProjectSourceIn(appDb, E6, APP_B);
        await sources.ensureProjectSourceIn(appDb, E6, APP_B);
        const rows = await sql`select 1 from project_apps
        where project_id = ${P4} and app_id = ${APP_B}`;
        expect(rows).toHaveLength(1);
      });

      it("the *In helpers run inside the caller's transaction", async () => {
        await expect(
          appDb.transaction(async (tx) => {
            await sources.ensureProjectSourceIn(tx, E8, APP_C);
            throw new Error("rollback");
          })
        ).rejects.toThrow("rollback");
        expect(await hasApp(P5, APP_C)).toBe(false);
      });
    });
  }
);
