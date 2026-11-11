import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The release repository against a real Panel database: the local scratch
// copy named by RELEASES_SCRATCH_DB (a migrated database in the
// opsdeck-postgres container), reached through its published port with the
// container's own superuser password, read from the container and never
// printed. Every fixture is named rel-it/RELIT and removed.
//
//   RELEASES_SCRATCH_DB=releases_scratch env -u SECRETS_KEY bun --bun vitest run tests/releases-repository-scratch.test.ts
const scratchDb = process.env.RELEASES_SCRATCH_DB;
if (scratchDb) {
  const password = encodeURIComponent(
    execFileSync("podman", [
      "exec",
      "opsdeck-postgres",
      "printenv",
      "POSTGRES_PASSWORD",
    ])
      .toString()
      .trim()
  );
  process.env.DATABASE_URL = `postgres://postgres:${password}@127.0.0.1:5432/${scratchDb}`;
  process.env.SECRETS_KEY = Buffer.alloc(32, 9).toString("base64");
}

describe.skipIf(!scratchDb)("release repository on scratch", async () => {
  const { eq, inArray } = await import("drizzle-orm");
  const { db, pgClient } = await import("@/lib/db");
  const s = await import("@/lib/db/schema");
  const { encryptSecret } = await import("@/lib/secrets");
  const { isUniqueViolation } = await import("@/lib/people/names");
  const repo = await import("@/lib/releases/repository");

  const COMPONENT = "rel-it-jar";
  const ids = {
    project: "",
    app: "",
    ci: "",
    server: "",
    env: "",
    other: "",
    target: "",
    otherTarget: "",
    user: randomUUID(),
  };

  async function one<T>(rows: Promise<T[]>): Promise<T> {
    const [row] = await rows;
    if (!row) throw new Error("insert returned no row");
    return row;
  }

  async function cleanup() {
    const projectRows = await db
      .select({ id: s.projects.id })
      .from(s.projects)
      .where(eq(s.projects.key, "RELIT"));
    const projectIds = projectRows.map((p) => p.id);
    if (projectIds.length > 0) {
      await db
        .delete(s.releases)
        .where(inArray(s.releases.projectId, projectIds));
      await db
        .delete(s.environments)
        .where(inArray(s.environments.projectId, projectIds));
      await db.delete(s.projects).where(inArray(s.projects.id, projectIds));
    }
    await db
      .delete(s.appComponents)
      .where(eq(s.appComponents.componentKey, COMPONENT));
    await db.delete(s.apps).where(eq(s.apps.appKey, "rel-it"));
    await db.delete(s.ciConnections).where(eq(s.ciConnections.name, "rel-it"));
    await db.delete(s.servers).where(eq(s.servers.name, "rel-it server"));
    await db.delete(s.users).where(eq(s.users.email, "rel-it@example.test"));
  }

  async function environment(name: string) {
    return (
      await one(
        db
          .insert(s.environments)
          .values({
            projectId: ids.project,
            name,
            slug: name.toLowerCase().replace(/\s+/g, "-"),
            appId: ids.app,
          })
          .returning({ id: s.environments.id })
      )
    ).id;
  }

  async function target(environmentId: string, deployDir: string) {
    return (
      await one(
        db
          .insert(s.deployTargets)
          .values({
            environmentId,
            componentKey: COMPONENT,
            serverId: ids.server,
            sourceBranch: "release/tmli",
            kind: "jar",
            jarName: "core.jar",
            systemdUnit: "core",
            deployDir,
            services: [],
          })
          .returning({ id: s.deployTargets.id })
      )
    ).id;
  }

  async function deployment(
    targetId: string,
    environmentId: string,
    tag: string
  ) {
    return (
      await one(
        db
          .insert(s.deployments)
          .values({
            targetId,
            environmentId,
            tag,
            trigger: "manual",
            status: "success",
          })
          .returning({ id: s.deployments.id })
      )
    ).id;
  }

  function newRelease(version: string, deploymentId: string | null) {
    return repo.insertReleaseWithRun(
      {
        projectId: ids.project,
        componentKey: COMPONENT,
        environmentId: ids.env,
        environmentName: "REL Main",
        deploymentId,
        branch: "release/tmli",
        tag: "rel-it-tag-1",
        commitSha: "abc1234",
        version,
        notes: null,
        createdBy: ids.user,
      },
      {
        environmentId: ids.env,
        userId: ids.user,
        description: `Release ${COMPONENT} ${version}`,
        kind: "release",
      }
    );
  }

  beforeAll(async () => {
    await cleanup();
    ids.project = (
      await one(
        db
          .insert(s.projects)
          .values({ key: "RELIT", name: "Releases IT" })
          .returning({ id: s.projects.id })
      )
    ).id;
    ids.ci = (
      await one(
        db
          .insert(s.ciConnections)
          .values({
            name: "rel-it",
            provider: "woodpecker",
            forge: "bitbucket",
            baseUrl: "https://ci.example.test",
          })
          .returning({ id: s.ciConnections.id })
      )
    ).id;
    ids.app = (
      await one(
        db
          .insert(s.apps)
          .values({ appKey: "rel-it", name: "Releases IT" })
          .returning({ id: s.apps.id })
      )
    ).id;
    await db.insert(s.appComponents).values({
      componentKey: COMPONENT,
      appId: ids.app,
      ciConnectionId: ids.ci,
      repoFullName: `example/${COMPONENT}`,
      bundleImage: `${COMPONENT}-deploy`,
      notifySecret: encryptSecret("notify"),
    });
    ids.server = (
      await one(
        db
          .insert(s.servers)
          .values({
            name: "rel-it server",
            host: "192.0.2.40",
            username: "deploy",
            password: "unused",
          })
          .returning({ id: s.servers.id })
      )
    ).id;
    await db.insert(s.users).values({
      id: ids.user,
      name: "Release Tester",
      email: "rel-it@example.test",
    });
    ids.env = await environment("REL Main");
    ids.other = await environment("REL Other");
    ids.target = await target(ids.env, "/opt/rel-it");
    ids.otherTarget = await target(ids.other, "/opt/rel-it-other");
    await db.insert(s.builds).values({
      componentKey: COMPONENT,
      branch: "release/tmli",
      tag: "rel-it-tag-1",
      commitSha: "abc1234",
    });
  });

  afterAll(async () => {
    await cleanup();
    await pgClient().end();
  });

  it("reads a deployment's source with its build", async () => {
    const id = await deployment(ids.target, ids.env, "rel-it-tag-1");
    expect(await repo.getReleaseSource(id)).toEqual({
      deploymentId: id,
      environmentId: ids.env,
      environmentName: "REL Main",
      projectId: ids.project,
      projectName: "Releases IT",
      status: "success",
      tag: "rel-it-tag-1",
      componentKey: COMPONENT,
      targetKind: "jar",
      branch: "release/tmli",
      commitSha: "abc1234",
    });
  });

  it("reads a source without a build row as branch and commit null", async () => {
    const id = await deployment(ids.target, ids.env, "rel-it-unknown-tag");
    expect(await repo.getReleaseSource(id)).toMatchObject({
      tag: "rel-it-unknown-tag",
      branch: null,
      commitSha: null,
    });
  });

  it("reports the environment of a deployment elsewhere, and null for none", async () => {
    const id = await deployment(ids.otherTarget, ids.other, "rel-it-tag-1");
    const source = await repo.getReleaseSource(id);
    expect(source?.environmentId).toBe(ids.other);
    expect(source?.environmentId).not.toBe(ids.env);
    expect(await repo.getReleaseSource(randomUUID())).toBeNull();
  });

  it("refuses a version in use while preparing and allows it after the release failed", async () => {
    const first = await newRelease("TMLI 2026-11-2", null);
    const run = await db
      .select({ kind: s.runs.kind, status: s.runs.status })
      .from(s.runs)
      .where(eq(s.runs.id, first.runId));
    expect(run).toEqual([{ kind: "release", status: "started" }]);

    const duplicate = await newRelease("TMLI 2026-11-2", null).catch(
      (e: unknown) => e
    );
    expect(isUniqueViolation(duplicate)).toBe(true);
    // The transaction rolled back: no second run was left behind.
    const runs = await db
      .select({ id: s.runs.id })
      .from(s.runs)
      .where(eq(s.runs.description, `Release ${COMPONENT} TMLI 2026-11-2`));
    expect(runs).toHaveLength(1);

    expect(await repo.markReleaseFailed(first.releaseId, "gone")).toBe(true);
    // Guarded: a failed release is not failed (or readied) again.
    expect(await repo.markReleaseFailed(first.releaseId, "again")).toBe(false);
    const second = await newRelease("TMLI 2026-11-2", null);
    expect(second.releaseId).not.toBe(first.releaseId);
  });

  it("keeps the job subject after the deployment row is deleted, with no target kind", async () => {
    const id = await deployment(ids.target, ids.env, "rel-it-tag-1");
    const { releaseId } = await newRelease("subject check", id);
    expect(await repo.getReleaseJobSubject(releaseId)).toMatchObject({
      id: releaseId,
      bundleImage: `${COMPONENT}-deploy`,
      targetKind: "jar",
      deploymentId: id,
    });
    await db.delete(s.deployments).where(eq(s.deployments.id, id));
    expect(await repo.getReleaseJobSubject(releaseId)).toMatchObject({
      id: releaseId,
      bundleImage: `${COMPONENT}-deploy`,
      targetKind: null,
      deploymentId: null,
    });
  });

  it("lists newest first with the creator's name and the stored sizes", async () => {
    const a = await newRelease("list a", null);
    const b = await newRelease("list b", null);
    expect(
      await repo.markReleaseReady(a.releaseId, {
        objectKey: "releases/x/a.jar",
        fileName: "a.jar",
        sizeBytes: 1000,
        sha256: "a".repeat(64),
      })
    ).toBe(true);
    await repo.markReleaseReady(b.releaseId, {
      objectKey: "releases/x/b.jar",
      fileName: "b.jar",
      sizeBytes: 234,
      sha256: "b".repeat(64),
    });
    const rows = await repo.listProjectReleases(ids.project);
    const listed = rows.filter((r) => r.version.startsWith("list "));
    expect(listed.map((r) => r.version)).toEqual(["list b", "list a"]);
    expect(listed.every((r) => r.createdByName === "Release Tester")).toBe(
      true
    );
    // What listReleases sums: ready rows' sizes, null for the others.
    const total = rows.reduce((sum, r) => sum + (r.sizeBytes ?? 0), 0);
    expect(total).toBe(1234);
    expect(
      rows.filter((r) => r.status !== "ready").map((r) => r.sizeBytes)
    ).toEqual(rows.filter((r) => r.status !== "ready").map(() => null));
  });

  it("refuses a project delete while the project has a release (RESTRICT)", async () => {
    const { pgErrorCode } = await import("@/lib/domains/errors");
    await newRelease("restrict check", null);
    const error = await db
      .delete(s.projects)
      .where(eq(s.projects.id, ids.project))
      .catch((e: unknown) => e);
    // restrict_violation, which removeProject turns into projectHasReleases.
    expect(pgErrorCode(error)).toBe("23001");
  });

  it("returns the stored key from the row delete", async () => {
    const { releaseId } = await newRelease("delete me", null);
    await repo.markReleaseReady(releaseId, {
      objectKey: "releases/x/d.jar",
      fileName: "d.jar",
      sizeBytes: 1,
      sha256: "d".repeat(64),
    });
    expect(await repo.deleteReleaseRow(releaseId)).toEqual({
      objectKey: "releases/x/d.jar",
    });
    expect(await repo.getRelease(releaseId)).toBeNull();
    expect(await repo.deleteReleaseRow(releaseId)).toEqual({
      objectKey: null,
    });
  });
});
