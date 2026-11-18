import { execFileSync, spawnSync } from "node:child_process";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";

// The read cores (xxxFor(scope, …)) against their session wrappers on a real
// Postgres: for an admin, an observer, an engineer member of one project and a
// qa user who is a member of nothing, each core given accessScopeForUser
// returns what the page's wrapper returns for that user's session, and
// refuses where the page refuses (same status, or the same emptiness). The
// local menara-postgres container (postgres 18) through its published port,
// with the superuser password read from the container and never printed; a
// scratch database is created, migrated and dropped.
//
//   ASSISTANT_SCRATCH_DB=1 env -u SECRETS_KEY bun --bun vitest run tests/read-cores-scratch.test.ts
const enabled = process.env.ASSISTANT_SCRATCH_DB === "1";
const CONTAINER = "menara-postgres";
const DB_NAME = "read_cores_scratch";

const session = vi.hoisted(() => ({
  user: null as null | { id: string; role: string },
}));

vi.mock("@/lib/auth-session", async () => {
  const { HTTPException } = await import("hono/http-exception");
  const current = async () =>
    session.user
      ? { user: session.user, session: { signInMethod: "passkey" } }
      : null;
  return {
    getServerSession: current,
    requireSession: async () => {
      const s = await current();
      if (!s) throw new HTTPException(401, { message: "Unauthorized" });
      return s;
    },
  };
});

// Service probes never leave the machine: every status command answers
// "active".
vi.mock("@/lib/ssh", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ssh")>()),
  executeRemoteCommand: vi.fn(async () => "active\n"),
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

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (!row) throw new Error("expected a row");
  return row;
}

/** The value, or the HTTP status it was refused with. */
async function outcome<T>(fn: () => Promise<T>) {
  try {
    return { value: await fn() };
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (typeof status !== "number") throw error;
    return { status };
  }
}

describe.skipIf(!enabled)("read cores match their session wrappers", () => {
  let client: ReturnType<typeof postgres>;
  let previousUrl: string | undefined;

  beforeAll(() => {
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
    client = postgres(url, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await client?.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    psql("postgres", ["-c", `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`]);
  });

  it("each core equals its wrapper for every role, refusals included", async () => {
    const d = drizzle({ client });
    const { accessScopeForUser, accessScopeFromSession } = await import(
      "@/lib/access-scope"
    );
    const envs = await import("@/server/services/environments");
    const services = await import("@/server/services/services");
    const deploys = await import("@/server/services/deploys");
    const runsService = await import("@/server/services/runs");
    const builds = await import("@/server/services/deploy-builds");

    const user = async (id: string, role: string) =>
      one(
        await d
          .insert(schema.users)
          .values({ id, name: role, email: `${role}@example.com`, role })
          .returning()
      );
    const admin = await user("00000000-0000-7000-8000-00000000b001", "admin");
    const observer = await user(
      "00000000-0000-7000-8000-00000000b002",
      "observer"
    );
    const engineer = await user(
      "00000000-0000-7000-8000-00000000b003",
      "engineer"
    );
    const qa = await user("00000000-0000-7000-8000-00000000b004", "qa");

    const server = one(
      await d
        .insert(schema.servers)
        .values({ name: "s", host: "192.0.2.10", username: "deploy" })
        .returning()
    );
    const app = one(
      await d
        .insert(schema.apps)
        .values({ appKey: "acme", name: "Acme" })
        .returning()
    );
    const ci = one(
      await d
        .insert(schema.ciConnections)
        .values({
          name: "ci",
          provider: "woodpecker",
          forge: "bitbucket",
          baseUrl: "https://ci.example.invalid",
        })
        .returning()
    );
    await d.insert(schema.appComponents).values({
      componentKey: "acme-api",
      appId: app.id,
      ciConnectionId: ci.id,
      repoFullName: "acme/api",
      bundleImage: "acme-api",
      notifySecret: "x",
    });

    // Two projects, one environment each, with a target, builds, a deploy
    // and its run; the engineer is a member of the first only.
    const seed = async (key: string, branch: string) => {
      const project = one(
        await d.insert(schema.projects).values({ name: key, key }).returning()
      );
      const env = one(
        await d
          .insert(schema.environments)
          .values({ projectId: project.id, name: `${key} dev`, slug: "dev" })
          .returning()
      );
      await d.insert(schema.environmentServices).values({
        environmentId: env.id,
        role: "backend",
        serverId: server.id,
        serviceType: "systemd",
        serviceName: `${key}-api`,
      });
      const target = one(
        await d
          .insert(schema.deployTargets)
          .values({
            environmentId: env.id,
            componentKey: "acme-api",
            serverId: server.id,
            sourceBranch: branch,
            deployDir: `/srv/${key}`,
            services: ["api"],
          })
          .returning()
      );
      const build = async (tag: string, at: string) =>
        one(
          await d
            .insert(schema.builds)
            .values({
              componentKey: "acme-api",
              branch,
              tag,
              commitSha: `sha-${tag}`,
              receivedAt: new Date(at),
            })
            .returning()
        );
      await build(`${key}-1`, "2026-11-01T10:00:00Z");
      const b2 = await build(`${key}-2`, "2026-11-02T10:00:00Z");
      const run = one(
        await d
          .insert(schema.runs)
          .values({
            environmentId: env.id,
            userId: admin.id,
            description: `Deploy ${key}-2`,
            status: "success",
            output: "pulling\nstarted\n",
            runAt: new Date("2026-11-02T10:01:00Z"),
          })
          .returning()
      );
      const deployment = one(
        await d
          .insert(schema.deployments)
          .values({
            targetId: target.id,
            environmentId: env.id,
            runId: run.id,
            tag: b2.tag,
            trigger: "manual",
            status: "success",
            buildId: b2.id,
            finishedAt: new Date("2026-11-02T10:05:00Z"),
          })
          .returning()
      );
      return { project, env, run, deployment };
    };
    const p1 = await seed("alpha", "main");
    const p2 = await seed("beta", "develop");
    await d
      .insert(schema.projectMembers)
      .values({ projectId: p1.project.id, userId: engineer.id });

    const people = [admin, observer, engineer, qa];
    const seesP1 = new Set([admin.id, observer.id, engineer.id]);
    const seesP2 = new Set([admin.id, observer.id]);

    for (const person of people) {
      session.user = { id: person.id, role: person.role ?? "qa" };
      const scope = await accessScopeForUser(person.id);
      expect(scope).toEqual(await accessScopeFromSession());

      // Environments list (scoped; sorted by the user's own recency).
      expect(await envs.listEnvironmentsFor(scope)).toEqual(
        await envs.listEnvironments()
      );
      expect(
        (await envs.listEnvironmentsFor(scope)).map((e) => e.id).sort()
      ).toEqual(
        [
          ...(seesP1.has(person.id) ? [p1.env.id] : []),
          ...(seesP2.has(person.id) ? [p2.env.id] : []),
        ].sort()
      );

      for (const { env, run, deployment, project } of [p1, p2]) {
        const sees = (project === p1.project ? seesP1 : seesP2).has(person.id);

        // Environment by id: undefined when invisible.
        const byId = await envs.getEnvironmentByIdFor(scope, env.id);
        expect(byId).toEqual(await envs.getEnvironmentById(env.id));
        expect(byId === undefined).toBe(!sees);

        // Running versions: 404 when invisible.
        const running = await outcome(() =>
          envs.getEnvironmentRunningFor(scope, env.id)
        );
        expect(running).toEqual(
          await outcome(() => envs.getEnvironmentRunning(env.id))
        );
        expect("status" in running ? running.status : 200).toBe(
          sees ? 200 : 404
        );

        // Service statuses: probed only after the permission passed.
        const statuses = await outcome(() =>
          services.getAllServiceStatusesFor(scope, env.id)
        );
        expect(statuses).toEqual(
          await outcome(() => services.getAllServiceStatuses(env.id))
        );
        expect(statuses).toEqual(
          sees
            ? {
                value: [{ role: "backend", state: "running", raw: "active" }],
              }
            : { status: 404 }
        );

        // Deploy history (targets with their recent deployments and builds).
        const targets = await outcome(() =>
          deploys.listDeployTargetsFor(scope, env.id)
        );
        expect(targets).toEqual(
          await outcome(() => deploys.listDeployTargets(env.id))
        );
        expect("status" in targets ? targets.status : 200).toBe(
          sees ? 200 : 404
        );

        // One deploy: the row the history shows, or the same refusal.
        const single = await outcome(() =>
          deploys.getDeploymentFor(scope, deployment.id)
        );
        if (targets.value) {
          const shown = targets.value
            .flatMap((t) => t.recentDeployments)
            .find((dep) => dep.id === deployment.id);
          expect(single).toEqual({
            value: { ...shown, componentKey: "acme-api" },
          });
        } else {
          expect(single).toEqual(targets);
        }

        // Its log: the run snapshot the live-run dialog streams.
        const snapshot = await runsService.getRunSnapshotFor(scope, run.id);
        expect(snapshot).toEqual(await runsService.getRunSnapshot(run.id));
        expect(snapshot?.output ?? null).toBe(
          sees ? "pulling\nstarted\n" : null
        );

        // Builds per project: what the project's Deploys pages list.
        const projectBuilds = await outcome(() =>
          builds.listProjectBuildsFor(scope, project.id, 20)
        );
        if (targets.value) {
          expect(projectBuilds).toEqual({
            value: targets.value.flatMap((t) => t.recentBuilds),
          });
        } else {
          expect(projectBuilds).toEqual(targets);
        }
      }
    }

    // A deployment id that does not exist, or is not a uuid, is a 404.
    const scope = await accessScopeForUser(admin.id);
    await expect(
      deploys.getDeploymentFor(scope, "00000000-0000-7000-8000-0000000000ff")
    ).rejects.toMatchObject({ status: 404 });
    await expect(deploys.getDeploymentFor(scope, "nope")).rejects.toMatchObject(
      { status: 404 }
    );
    // The build list honours the limit, newest first.
    const limited = await builds.listProjectBuildsFor(scope, p1.project.id, 1);
    expect(limited.map((b) => b.tag)).toEqual(["alpha-2"]);
  });
});
