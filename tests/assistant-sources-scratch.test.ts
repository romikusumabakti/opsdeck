import { execFileSync, spawnSync } from "node:child_process";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";

// resolveEnvironmentSources and resolveProjectSources against a real Postgres: the local
// menara-postgres container (postgres 18) through its published port, with
// the container's superuser password read from the container and never
// printed. It creates a scratch database, migrates it with `menara migrate`
// and drops it afterwards; no other database is touched.
//
//   ASSISTANT_SCRATCH_DB=1 env -u SECRETS_KEY bun --bun vitest run tests/assistant-sources-scratch.test.ts
const enabled = process.env.ASSISTANT_SCRATCH_DB === "1";
const CONTAINER = "menara-postgres";
const DB_NAME = "assistant_sources_scratch";

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

describe.skipIf(!enabled)(
  "resolveEnvironmentSources on a real Postgres",
  () => {
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
      // lib/db reads DATABASE_URL lazily, on the first query.
      previousUrl = process.env.DATABASE_URL;
      process.env.DATABASE_URL = url;
      client = postgres(url, { max: 1, onnotice: () => {} });
    });

    afterAll(async () => {
      await client?.end();
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
      psql("postgres", [
        "-c",
        `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`,
      ]);
    });

    it("resolves running commits, falls back to the tag and reports never-deployed targets", async () => {
      const d = drizzle({ client });
      const { resolveEnvironmentSources } = await import(
        "@/lib/assistant/sources"
      );
      const project = one(
        await d
          .insert(schema.projects)
          .values({ name: "P", key: "p" })
          .returning()
      );
      const env = one(
        await d
          .insert(schema.environments)
          .values({ projectId: project.id, name: "Dev", slug: "dev" })
          .returning()
      );
      const server = one(
        await d
          .insert(schema.servers)
          .values({ name: "s", host: "h", username: "u" })
          .returning()
      );
      const ci = one(
        await d
          .insert(schema.ciConnections)
          .values({
            name: "ci",
            provider: "woodpecker",
            forge: "bitbucket",
            baseUrl: "https://ci.example.net",
          })
          .returning()
      );
      const app = one(
        await d
          .insert(schema.apps)
          .values({ appKey: "app", name: "App" })
          .returning()
      );
      for (const key of ["comp-a", "comp-b", "comp-c", "comp-d"]) {
        await d.insert(schema.appComponents).values({
          componentKey: key,
          appId: app.id,
          ciConnectionId: ci.id,
          repoFullName: `org/${key}`,
          bundleImage: key,
          notifySecret: "x",
        });
      }
      const target = async (componentKey: string, sourceBranch: string) =>
        one(
          await d
            .insert(schema.deployTargets)
            .values({
              environmentId: env.id,
              componentKey,
              serverId: server.id,
              sourceBranch,
              deployDir: `/srv/${componentKey}`,
              services: ["app"],
            })
            .returning()
        );
      const tA = await target("comp-a", "main");
      const tB = await target("comp-b", "develop");
      const tC = await target("comp-c", "release");
      const tD = await target("comp-d", "legacy");

      const build = async (componentKey: string, tag: string, sha: string) =>
        one(
          await d
            .insert(schema.builds)
            .values({ componentKey, branch: "main", tag, commitSha: sha })
            .returning()
        );
      const bOld = await build("comp-a", "v1", "sha-old");
      const bNew = await build("comp-a", "v2", "sha-new");
      await build("comp-b", "v7", "sha-b");
      const bOldB = await build("comp-b", "v6", "sha-b-old");
      await build("comp-a", "v3", "sha-failed");

      const deploy = (
        targetId: string,
        tag: string,
        status: "success" | "failed",
        buildId: string | null,
        at: string
      ) =>
        d.insert(schema.deployments).values({
          targetId,
          environmentId: env.id,
          tag,
          trigger: "manual",
          status,
          buildId,
          createdAt: new Date(at),
          finishedAt: status === "success" ? new Date(at) : null,
        });
      await deploy(tA.id, "v1", "success", bOld.id, "2026-11-01T10:00:00Z");
      await deploy(tA.id, "v2", "success", bNew.id, "2026-11-02T10:00:00Z");
      await deploy(tA.id, "v3", "failed", null, "2026-11-03T10:00:00Z");
      await deploy(tD.id, "v9", "success", null, "2026-11-04T10:00:00Z");
      await deploy(tB.id, "v7", "success", null, "2026-11-02T11:00:00Z");
      // Older successes, linked or by tag, are not what runs.
      await deploy(tB.id, "v6", "success", bOldB.id, "2026-11-01T11:00:00Z");
      await deploy(tD.id, "v8", "success", null, "2026-11-03T10:00:00Z");

      const sources = await resolveEnvironmentSources(env.id);
      const byKey = Object.fromEntries(sources.map((s) => [s.componentKey, s]));

      expect(byKey["comp-a"]).toMatchObject({
        repoFullName: "org/comp-a",
        ciConnectionId: ci.id,
        commitSha: "sha-new",
        deployed: true,
        deployedAt: "2026-11-02T10:00:00.000Z",
      });
      expect(byKey["comp-b"]).toMatchObject({
        commitSha: "sha-b",
        deployed: true,
      });
      expect(byKey["comp-c"]).toEqual({
        componentKey: "comp-c",
        repoFullName: "org/comp-c",
        ciConnectionId: ci.id,
        commitSha: null,
        ref: tC.sourceBranch,
        deployed: false,
        deployedAt: null,
      });
      expect(byKey["comp-d"]).toMatchObject({
        commitSha: null,
        ref: "legacy",
        deployed: true,
        deployedAt: "2026-11-04T10:00:00.000Z",
      });
      expect(sources).toHaveLength(4);

      // The dashboard's view: the same commits, plus the deployed tag.
      const { resolveRunningSources } = await import("@/lib/running-sources");
      const running = Object.fromEntries(
        (await resolveRunningSources(env.id)).map((s) => [
          s.componentKey,
          { tag: s.tag, commitSha: s.commitSha },
        ])
      );
      expect(running).toEqual({
        "comp-a": { tag: "v2", commitSha: "sha-new" },
        "comp-b": { tag: "v7", commitSha: "sha-b" },
        "comp-c": { tag: null, commitSha: null },
        "comp-d": { tag: "v9", commitSha: null },
      });
    });

    it("resolves the project branches of every linked app, with each component's connection", async () => {
      const d = drizzle({ client });
      const { resolveProjectSources } = await import(
        "@/lib/assistant/project-sources"
      );
      const project = one(
        await d
          .insert(schema.projects)
          .values({ name: "Q", key: "q" })
          .returning()
      );
      const ci = one(
        await d
          .insert(schema.ciConnections)
          .values({
            name: "ci-q",
            provider: "woodpecker",
            forge: "bitbucket",
            baseUrl: "https://ci.example.net",
          })
          .returning()
      );
      const app = one(
        await d
          .insert(schema.apps)
          .values({ appKey: "linked", name: "Linked" })
          .returning()
      );
      // Not linked to the project: never listed.
      const unrelated = one(
        await d
          .insert(schema.apps)
          .values({ appKey: "unrelated", name: "Unrelated" })
          .returning()
      );
      await d.insert(schema.projectApps).values({
        projectId: project.id,
        appId: app.id,
      });
      await d.insert(schema.appComponents).values([
        {
          componentKey: "q-api",
          appId: app.id,
          ciConnectionId: ci.id,
          repoFullName: "org/q-api",
          bundleImage: "q-api",
          notifySecret: "x",
        },
        {
          componentKey: "q-web",
          appId: app.id,
          ciConnectionId: ci.id,
          repoFullName: "org/q-web",
          bundleImage: "q-web",
          notifySecret: "x",
          buildSpec: { branches: ["develop"] } as never,
        },
        {
          componentKey: "u-api",
          appId: unrelated.id,
          ciConnectionId: ci.id,
          repoFullName: "org/u-api",
          bundleImage: "u-api",
          notifySecret: "x",
        },
      ]);
      await d.insert(schema.projectComponentBranches).values({
        projectId: project.id,
        componentKey: "q-api",
        branch: "q/development",
      });

      expect(await resolveProjectSources(project.id)).toEqual([
        {
          componentKey: "q-api",
          repoFullName: "org/q-api",
          ciConnectionId: ci.id,
          commitSha: null,
          ref: "q/development",
          deployed: false,
          deployedAt: null,
        },
        {
          componentKey: "q-web",
          repoFullName: "org/q-web",
          ciConnectionId: ci.id,
          commitSha: null,
          ref: "develop",
          deployed: false,
          deployedAt: null,
        },
      ]);
    });
  }
);
