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

// The project-groups service and the project create/edit group rules against a
// real Postgres: a throwaway database in the local menara-postgres container
// (superuser password read from the container, never printed), migrated with
// `menara migrate` and dropped afterwards. Covers the merge's atomicity under
// concurrent writers, the case-/space-insensitive name rule (also on the
// unique-index race), counts over the viewer's visible projects only, and who
// may manage groups or set a project's group.
//
//   PROJECT_GROUPS_SCRATCH=1 env -u SECRETS_KEY bun --bun vitest run tests/project-groups-scratch.test.ts
const enabled = process.env.PROJECT_GROUPS_SCRATCH === "1";
const CONTAINER = "menara-postgres";
const DB_NAME = `project_groups_service_${randomBytes(4).toString("hex")}`;

const session = vi.hoisted(() => ({
  user: { id: "", role: "admin", name: "Admin" },
}));
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));
vi.mock("@/lib/auth-session", () => {
  const current = async () => ({
    user: session.user,
    session: { signInMethod: "passkey" },
  });
  return { requireSession: current, getServerSession: current };
});

const ADMIN = "00000000-0000-7000-8000-00000000d001";
const ENGINEER = "00000000-0000-7000-8000-00000000d002";
const INFRA = "00000000-0000-7000-8000-00000000d003";
const STAFF = "00000000-0000-7000-8000-00000000d004";
const MISSING = "00000000-0000-7000-8000-0000000000ff";

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

describe.skipIf(!enabled)("project groups service on Postgres", () => {
  let sql: ReturnType<typeof postgres>;
  let other: ReturnType<typeof postgres>;
  let previousUrl: string | undefined;
  let svc: typeof import("@/server/services/project-groups");
  let catalog: typeof import("@/server/services/project-catalog");

  const groupRows = () =>
    sql<{ id: string; name: string; rank: string }[]>`
      select id, name, rank from project_groups order by rank`;
  const groupOf = async (key: string) => {
    const [row] = await sql<{ name: string | null }[]>`
      select g.name from projects p left join project_groups g
        on g.id = p.group_id where p.key = ${key}`;
    return row?.name ?? null;
  };
  const activity = (action: string) =>
    sql<{ data: Record<string, string | number> }[]>`
      select data from activity_log where action = ${action}
      order by created_at`;
  const project = async (key: string, groupId: string | null) => {
    const [row] = await sql<{ id: string }[]>`
      insert into projects (name, key, group_id)
      values (${`Project ${key}`}, ${key}, ${groupId}) returning id`;
    if (!row) throw new Error("no project");
    return row.id;
  };
  // Wait until some backend is blocked on a lock (the service call under test).
  const waitForLockWait = async () => {
    for (let i = 0; i < 100; i++) {
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
        where datname = ${DB_NAME} and wait_event_type = 'Lock'`;
      if ((row?.n ?? 0) > 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("the call never waited on a lock");
  };

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
    const base = `postgres://postgres:${password}@127.0.0.1:5432`;
    const admin = postgres(`${base}/postgres`, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${DB_NAME}`);
    await admin.end();
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
    other = postgres(url, { max: 1, onnotice: () => {} });
    for (const [id, role] of [
      [ADMIN, "admin"],
      [ENGINEER, "engineer"],
      [INFRA, "infra"],
      [STAFF, "staff"],
    ] as const) {
      await sql`insert into users (id, name, email, role)
        values (${id}, ${role}, ${`${role}@example.com`}, ${role})`;
    }
    svc = await import("@/server/services/project-groups");
    catalog = await import("@/server/services/project-catalog");
  });

  afterAll(async () => {
    await sql?.end();
    await other?.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    if (!enabled) return;
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
    const admin = postgres(
      `postgres://postgres:${password}@127.0.0.1:5432/postgres`,
      { max: 1, onnotice: () => {} }
    );
    await admin.unsafe(`drop database if exists ${DB_NAME} with (force)`);
    await admin.end();
  });

  beforeEach(async () => {
    await sql`delete from activity_log`;
    await sql`delete from project_members`;
    await sql`delete from projects`;
    await sql`delete from project_groups`;
    as(ADMIN, "admin");
  });

  describe("names", () => {
    it("refuses a name that differs only in case or spacing, writing nothing", async () => {
      await svc.createGroup({ name: "Acme " });
      expect(await refusal(svc.createGroup({ name: "acme" }))).toEqual({
        status: 409,
        code: "groupNameTaken",
      });
      expect(await refusal(svc.createGroup({ name: "  ACME  " }))).toEqual({
        status: 409,
        code: "groupNameTaken",
      });
      const rows = await groupRows();
      expect(rows.map((r) => r.name)).toEqual(["Acme"]);
      expect(await activity("projectGroup.created")).toHaveLength(1);
    });

    it("answers the unique-index race with the same coded 409", async () => {
      const results = await Promise.allSettled(
        ["Delta", " delta", "DELTA "].map((name) => svc.createGroup({ name }))
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results) {
        if (r.status === "rejected") {
          expect(r.reason).toMatchObject({
            status: 409,
            code: "groupNameTaken",
          });
        }
      }
      expect(await groupRows()).toHaveLength(1);
    });

    it("trims and limits names to 80 characters", async () => {
      const created = await svc.createGroup({ name: `  ${"x".repeat(80)}  ` });
      expect(created.name).toBe("x".repeat(80));
      expect(
        (await refusal(svc.createGroup({ name: "y".repeat(81) }))).status
      ).toBe(400);
      expect((await refusal(svc.createGroup({ name: "   " }))).status).toBe(
        400
      );
    });

    it("renames, refusing another group's name and a missing group", async () => {
      const acme = await svc.createGroup({ name: "Acme" });
      await svc.createGroup({ name: "Beta" });
      expect(await refusal(svc.renameGroup(acme.id, { name: "beta" }))).toEqual(
        { status: 409, code: "groupNameTaken" }
      );
      // Its own name in another case is fine.
      expect((await svc.renameGroup(acme.id, { name: "ACME" })).name).toBe(
        "ACME"
      );
      expect(
        await refusal(svc.renameGroup(MISSING, { name: "Gamma" }))
      ).toEqual({ status: 404, code: "groupNotFound" });
      expect((await activity("projectGroup.renamed"))[0]?.data).toEqual({
        from: "Acme",
        to: "ACME",
      });
    });
  });

  describe("rank", () => {
    it("appends new groups and moves one between its neighbours", async () => {
      const a = await svc.createGroup({ name: "Alpha" });
      const b = await svc.createGroup({ name: "Bravo" });
      const c = await svc.createGroup({ name: "Charlie" });
      expect((await groupRows()).map((r) => r.name)).toEqual([
        "Alpha",
        "Bravo",
        "Charlie",
      ]);
      await svc.reorderGroup(c.id, { before: a.id });
      expect((await groupRows()).map((r) => r.name)).toEqual([
        "Charlie",
        "Alpha",
        "Bravo",
      ]);
      await svc.reorderGroup(c.id, { after: a.id });
      expect((await groupRows()).map((r) => r.name)).toEqual([
        "Alpha",
        "Charlie",
        "Bravo",
      ]);
      await svc.reorderGroup(a.id, { after: c.id, before: b.id });
      expect((await groupRows()).map((r) => r.name)).toEqual([
        "Charlie",
        "Alpha",
        "Bravo",
      ]);
      await svc.reorderGroup(c.id, { after: b.id });
      expect((await groupRows()).map((r) => r.name)).toEqual([
        "Alpha",
        "Bravo",
        "Charlie",
      ]);
      expect(await activity("projectGroup.reordered")).toHaveLength(4);
      // A new group still lands last.
      await svc.createGroup({ name: "Delta" });
      expect((await groupRows()).at(-1)?.name).toBe("Delta");
    });

    it("refuses a missing neighbour, itself, or no neighbour", async () => {
      const a = await svc.createGroup({ name: "Alpha" });
      const b = await svc.createGroup({ name: "Bravo" });
      expect(await refusal(svc.reorderGroup(a.id, { after: MISSING }))).toEqual(
        { status: 404, code: "groupNotFound" }
      );
      expect(await refusal(svc.reorderGroup(MISSING, { after: a.id }))).toEqual(
        { status: 404, code: "groupNotFound" }
      );
      expect(
        (await refusal(svc.reorderGroup(a.id, { after: a.id }))).status
      ).toBe(400);
      expect((await refusal(svc.reorderGroup(a.id, {}))).status).toBe(400);
      // Neighbours in the wrong order.
      const c = await svc.createGroup({ name: "Charlie" });
      expect(
        (await refusal(svc.reorderGroup(c.id, { after: b.id, before: a.id })))
          .status
      ).toBe(400);
    });
  });

  describe("listGroups", () => {
    it("lists every group, counting only the viewer's visible projects", async () => {
      const acme = await svc.createGroup({ name: "Acme" });
      const beta = await svc.createGroup({ name: "Beta" });
      await svc.createGroup({ name: "Empty" });
      const p1 = await project("PA1", acme.id);
      await project("PA2", acme.id);
      await project("PB1", beta.id);
      await project("PN1", null);
      await sql`insert into project_members (project_id, user_id)
        values (${p1}, ${ENGINEER})`;

      const counts = (rows: { name: string; projectCount: number }[]) =>
        rows.map((r) => [r.name, r.projectCount]);
      expect(counts(await svc.listGroups())).toEqual([
        ["Acme", 2],
        ["Beta", 1],
        ["Empty", 0],
      ]);
      as(ENGINEER, "engineer");
      const seen = await svc.listGroups();
      expect(counts(seen)).toEqual([
        ["Acme", 1],
        ["Beta", 0],
        ["Empty", 0],
      ]);
      expect(Object.keys(seen[0] ?? {}).sort()).toEqual([
        "id",
        "name",
        "projectCount",
        "rank",
      ]);
      as(STAFF, "staff");
      expect((await refusal(svc.listGroups())).status).toBe(403);
    });
  });

  describe("merge", () => {
    it("moves every project of A into B and deletes A in one step", async () => {
      const a = await svc.createGroup({ name: "Acme" });
      const b = await svc.createGroup({ name: "Beta" });
      await project("MA1", a.id);
      await project("MA2", a.id);
      await project("MB1", b.id);
      const merged = await svc.mergeGroups({ from: a.id, into: b.id });
      expect(merged).toMatchObject({ id: b.id, name: "Beta" });
      expect((await groupRows()).map((r) => r.name)).toEqual(["Beta"]);
      for (const key of ["MA1", "MA2", "MB1"]) {
        expect(await groupOf(key)).toBe("Beta");
      }
      expect((await activity("projectGroup.merged"))[0]?.data).toEqual({
        from: "Acme",
        into: "Beta",
        count: 2,
      });
    });

    it("refuses merging a group into itself or a missing group, changing nothing", async () => {
      const a = await svc.createGroup({ name: "Acme" });
      await project("SA1", a.id);
      expect(
        await refusal(svc.mergeGroups({ from: a.id, into: a.id }))
      ).toEqual({ status: 400, code: "groupMergeSelf" });
      expect(
        await refusal(svc.mergeGroups({ from: a.id, into: MISSING }))
      ).toEqual({ status: 404, code: "groupNotFound" });
      expect(
        await refusal(svc.mergeGroups({ from: MISSING, into: a.id }))
      ).toEqual({ status: 404, code: "groupNotFound" });
      expect(await groupOf("SA1")).toBe("Acme");
      expect(await activity("projectGroup.merged")).toEqual([]);
    });

    it("waits for a concurrent rename of A, then still merges everything", async () => {
      const a = await svc.createGroup({ name: "Acme" });
      const b = await svc.createGroup({ name: "Beta" });
      await project("CR1", a.id);
      const reserved = await other.reserve();
      try {
        await reserved`begin`;
        await reserved`update project_groups set name = 'Acme Renamed'
          where id = ${a.id}`;
        const merge = svc.mergeGroups({ from: a.id, into: b.id });
        await waitForLockWait();
        await reserved`commit`;
        await merge;
      } finally {
        reserved.release();
      }
      expect((await groupRows()).map((r) => r.name)).toEqual(["Beta"]);
      expect(await groupOf("CR1")).toBe("Beta");
      expect((await activity("projectGroup.merged"))[0]?.data).toMatchObject({
        from: "Acme Renamed",
      });
    });

    it("moves a project linked to A by a concurrent writer", async () => {
      const a = await svc.createGroup({ name: "Acme" });
      const b = await svc.createGroup({ name: "Beta" });
      await project("CW1", a.id);
      const reserved = await other.reserve();
      try {
        await reserved`begin`;
        await reserved`insert into projects (name, key, group_id)
          values ('Project CW2', 'CW2', ${a.id})`;
        const merge = svc.mergeGroups({ from: a.id, into: b.id });
        await waitForLockWait();
        await reserved`commit`;
        await merge;
      } finally {
        reserved.release();
      }
      expect(await groupOf("CW1")).toBe("Beta");
      expect(await groupOf("CW2")).toBe("Beta");
      const [orphans] = await sql<{ n: number }[]>`
        select count(*)::int as n from projects where group_id is null`;
      expect(orphans?.n).toBe(0);
    });

    it("refuses cleanly when a concurrent delete of A wins", async () => {
      const a = await svc.createGroup({ name: "Acme" });
      const b = await svc.createGroup({ name: "Beta" });
      await project("CD1", b.id);
      const reserved = await other.reserve();
      let outcome: unknown;
      try {
        await reserved`begin`;
        await reserved`delete from project_groups where id = ${a.id}`;
        const merge = refusal(svc.mergeGroups({ from: a.id, into: b.id }));
        await waitForLockWait();
        await reserved`commit`;
        outcome = await merge;
      } finally {
        reserved.release();
      }
      expect(outcome).toEqual({ status: 404, code: "groupNotFound" });
      expect((await groupRows()).map((r) => r.name)).toEqual(["Beta"]);
      expect(await groupOf("CD1")).toBe("Beta");
      expect(await activity("projectGroup.merged")).toEqual([]);
    });

    it("makes a concurrent delete of A wait and then find nothing", async () => {
      const a = await svc.createGroup({ name: "Acme" });
      const b = await svc.createGroup({ name: "Beta" });
      await project("CX1", a.id);
      const reserved = await other.reserve();
      try {
        // Hold B (the merge's second lock) so the merge sits inside its
        // transaction with A already locked.
        await reserved`begin`;
        await reserved`select id from project_groups where id = ${b.id} for update`;
        const merge = svc.mergeGroups({ from: a.id, into: b.id });
        await waitForLockWait();
        const deleting = refusal(svc.deleteGroup(a.id));
        await reserved`commit`;
        await merge;
        expect(await deleting).toEqual({ status: 404, code: "groupNotFound" });
      } finally {
        reserved.release();
      }
      expect(await groupOf("CX1")).toBe("Beta");
    });
  });

  describe("delete", () => {
    it("ungroups the projects and records the count", async () => {
      const a = await svc.createGroup({ name: "Acme" });
      await project("DA1", a.id);
      await project("DA2", a.id);
      await svc.deleteGroup(a.id);
      expect(await groupRows()).toEqual([]);
      expect(await groupOf("DA1")).toBeNull();
      expect((await activity("projectGroup.deleted"))[0]?.data).toEqual({
        group: "Acme",
        count: 2,
      });
      expect(await refusal(svc.deleteGroup(a.id))).toEqual({
        status: 404,
        code: "groupNotFound",
      });
    });
  });

  describe("who may manage groups", () => {
    for (const [id, role] of [
      [ENGINEER, "engineer"],
      [INFRA, "infra"],
      [STAFF, "staff"],
    ] as const) {
      it(`refuses ${role} every management call, writing nothing`, async () => {
        const a = await svc.createGroup({ name: "Acme" });
        const b = await svc.createGroup({ name: "Beta" });
        await project("WA1", a.id);
        as(id, role);
        for (const call of [
          svc.createGroup({ name: "Gamma" }),
          svc.renameGroup(a.id, { name: "Renamed" }),
          svc.reorderGroup(b.id, { before: a.id }),
          svc.mergeGroups({ from: a.id, into: b.id }),
          svc.deleteGroup(a.id),
        ]) {
          expect((await refusal(call)).status).toBe(403);
        }
        expect((await groupRows()).map((r) => r.name)).toEqual([
          "Acme",
          "Beta",
        ]);
        expect(await groupOf("WA1")).toBe("Acme");
      });
    }
  });

  describe("a project's group", () => {
    it("lets an admin create a project in a group, never writing client", async () => {
      const a = await svc.createGroup({ name: "Acme" });
      const created = await catalog.addProject({
        name: "Kestrel",
        key: "KST",
        groupId: a.id,
        client: "Legacy label",
      });
      expect(created.success).toBe(true);
      expect(await groupOf("KST")).toBe("Acme");
      const [row] = await sql<{ client: string | null }[]>`
        select client from projects where key = 'KST'`;
      expect(row?.client).toBeNull();
      expect(
        await refusal(
          catalog.addProject({ name: "Osprey", key: "OSP", groupId: MISSING })
        )
      ).toEqual({ status: 404, code: "groupNotFound" });
      // The driver error arrives wrapped; a taken key is still told apart.
      expect(
        await catalog.addProject({ name: "Again", key: "KST", groupId: null })
      ).toEqual({ success: false, message: "keyTaken" });
      const other = await catalog.addProject({ name: "Osprey", key: "OSP" });
      if (!other.success || !other.data) throw new Error("not created");
      expect(await catalog.editProject(other.data.id, { key: "KST" })).toEqual({
        success: false,
        message: "keyTaken",
      });
    });

    it("refuses an engineer setting a group on create, creating nothing", async () => {
      const a = await svc.createGroup({ name: "Acme" });
      as(ENGINEER, "engineer");
      expect(
        await refusal(
          catalog.addProject({ name: "Kestrel", key: "KST", groupId: a.id })
        )
      ).toEqual({ status: 403, code: "projectGroupForbidden" });
      const [n] = await sql<{ n: number }[]>`
        select count(*)::int as n from projects`;
      expect(n?.n).toBe(0);
      // Without a group the engineer still creates projects.
      expect(
        (
          await catalog.addProject({
            name: "Kestrel",
            key: "KST",
            groupId: null,
          })
        ).success
      ).toBe(true);
    });

    it("lets only an admin change a project's group, recording it", async () => {
      const a = await svc.createGroup({ name: "Acme" });
      const b = await svc.createGroup({ name: "Beta" });
      const id = await project("EP1", a.id);
      await sql`insert into project_members (project_id, user_id)
        values (${id}, ${ENGINEER})`;

      as(ENGINEER, "engineer");
      expect(await refusal(catalog.editProject(id, { groupId: b.id }))).toEqual(
        { status: 403, code: "projectGroupForbidden" }
      );
      expect(await refusal(catalog.editProject(id, { groupId: null }))).toEqual(
        { status: 403, code: "projectGroupForbidden" }
      );
      expect(await groupOf("EP1")).toBe("Acme");
      // Sending the unchanged group with other edits is fine.
      expect(
        (await catalog.editProject(id, { name: "Renamed", groupId: a.id }))
          .success
      ).toBe(true);
      expect(await activity("project.groupChanged")).toEqual([]);

      as(ADMIN, "admin");
      expect((await catalog.editProject(id, { groupId: b.id })).success).toBe(
        true
      );
      expect(await groupOf("EP1")).toBe("Beta");
      expect(
        await refusal(catalog.editProject(id, { groupId: MISSING }))
      ).toEqual({ status: 404, code: "groupNotFound" });
      expect((await catalog.editProject(id, { groupId: null })).success).toBe(
        true
      );
      expect(await groupOf("EP1")).toBeNull();
      expect(
        (await activity("project.groupChanged")).map((r) => r.data)
      ).toEqual([
        { project: "Renamed", group: "Beta" },
        { project: "Renamed", group: "" },
      ]);
    });
  });
});
