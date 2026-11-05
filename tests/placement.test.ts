import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canPlaceEnvironment,
  type OrgPermissions,
  type ProjectRole,
} from "@/lib/permissions";

// Server placement: who may put a new environment on a server. `restricted`
// keeps today's rule (project environment:create + org server:manage); `open`
// also admits project contributors. Changing a server's placement only affects
// later placements, never the environments already on it.

const PROJECT_ID = "0197f3a0-1b2c-7def-8000-0123456789f1";
const SERVER_OPEN = "0197f3a0-1b2c-7def-8000-0123456789c1";
const SERVER_RESTRICTED = "0197f3a0-1b2c-7def-8000-0123456789c2";
const OWNER_ID = "0197f3a0-1b2c-7def-8000-0123456789d1";

describe("canPlaceEnvironment", () => {
  // [orgRole, projectRole, restricted, open]
  const MATRIX: [string, ProjectRole, boolean, boolean][] = [
    ["admin", "viewer", false, false],
    ["admin", "contributor", false, true],
    ["admin", "maintainer", true, true],
    ["infra", "viewer", false, false],
    ["infra", "contributor", false, true],
    ["infra", "maintainer", true, true],
    ["member", "viewer", false, false],
    ["member", "contributor", false, true],
    ["member", "maintainer", false, true],
  ];
  for (const [org, project, restricted, open] of MATRIX) {
    it(`${org} × ${project}: restricted=${restricted}, open=${open}`, () => {
      expect(canPlaceEnvironment(org, project, "restricted")).toBe(restricted);
      expect(canPlaceEnvironment(org, project, "open")).toBe(open);
    });
  }

  it("refuses a caller without a project role on either placement", () => {
    for (const org of ["admin", "infra", "member"]) {
      expect(canPlaceEnvironment(org, null, "restricted")).toBe(false);
      expect(canPlaceEnvironment(org, null, "open")).toBe(false);
    }
  });
});

type Call = { op: string; table?: unknown; values?: unknown };

const state = vi.hoisted(() => ({
  orgRole: "member" as string,
  projectRole: "contributor" as string | null,
  userId: "0197f3a0-1b2c-7def-8000-0123456789a9",
  placements: {} as Record<string, "restricted" | "open">,
  calls: [] as Call[],
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: async () => ({
    user: { id: state.userId, role: state.orgRole },
  }),
  getServerSession: async () => ({
    user: { id: state.userId, role: state.orgRole },
  }),
}));

// The guards themselves are covered in owner-rights.test.ts; here they answer
// from the state, with the real permission table.
vi.mock("@/lib/authz", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/authz")>();
  const { canOrg } = await import("@/lib/permissions");
  return {
    ForbiddenError: real.ForbiddenError,
    getProjectRole: async () => state.projectRole,
    projectScope: () => undefined,
    requireOrgPermission: async (perms: OrgPermissions) => {
      if (!canOrg(state.orgRole, perms)) throw new real.ForbiddenError();
      return { user: { id: state.userId, role: state.orgRole } };
    },
    requireProjectPermission: async () => {
      if (!state.projectRole) {
        const { HTTPException } = await import("hono/http-exception");
        throw new HTTPException(404, { message: "Not Found" });
      }
      return {
        session: { user: { id: state.userId, role: state.orgRole } },
        role: state.projectRole,
        projectId: PROJECT_ID,
        isOwner: false,
      };
    },
  };
});
vi.mock("@/lib/secrets", () => ({
  encryptNullable: (v: string | null | undefined) => v ?? null,
  encryptSecret: (v: string) => `enc:${v}`,
  decryptSecret: (v: string) => v,
}));
vi.mock("@/server/i18n", () => ({
  getServerTranslator: async () => (key: string) => key,
}));

vi.mock("@/lib/db", async () => {
  const schema = await import("@/lib/db/schema");
  const rowsFor = (table: unknown): unknown[] => {
    if (table === schema.servers) {
      return Object.entries(state.placements).map(([id, placement]) => ({
        id,
        placement,
      }));
    }
    if (table === schema.users) return [{ id: OWNER_ID }];
    return [];
  };
  // A query builder: awaiting it yields rows; every method returns it again.
  const query = (call: Call) => {
    // biome-ignore lint/suspicious/noExplicitAny: self-referential mock builder
    const chain: any = {
      from: (table: unknown) => {
        call.table = table;
        return chain;
      },
      values: (values: unknown) => {
        call.values = values;
        return chain;
      },
      set: (values: unknown) => {
        call.values = values;
        return chain;
      },
      where: () => chain,
      innerJoin: () => chain,
      leftJoin: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      returning: () => chain,
      // biome-ignore lint/suspicious/noThenProperty: awaitable query builder
      then: (resolve: (rows: unknown[]) => unknown, reject: () => unknown) =>
        Promise.resolve(
          call.op === "select"
            ? rowsFor(call.table)
            : [
                {
                  id: "0197f3a0-1b2c-7def-8000-0123456789e1",
                  ...(call.values as object),
                },
              ]
        ).then(resolve, reject),
    };
    return chain;
  };
  const record = (op: string) => (table?: unknown) => {
    const call: Call = { op, table };
    state.calls.push(call);
    return query(call);
  };
  const ops = {
    select: () => record("select")(),
    insert: record("insert"),
    update: record("update"),
    delete: record("delete"),
  };
  return {
    db: {
      ...ops,
      transaction: async (fn: (tx: typeof ops) => unknown) => fn(ops),
    },
  };
});

const schema = await import("@/lib/db/schema");
const { createEnvironment } = await import("@/server/services/environments");
const { updateServer } = await import("@/server/services/servers");
const { serverInputSchema, serverUpdateSchema } = await import(
  "@/lib/validation"
);

const backend = {
  backendServerId: SERVER_OPEN,
  backendServiceType: "docker",
  backendServiceName: "api",
};
const databaseOn = (serverId: string) => ({
  hasDatabase: true,
  dbServerId: serverId,
  dbServiceType: "docker",
  dbServiceName: "pg",
  dbType: "postgres",
  dbName: "app",
  dbBackupPath: "/backups",
});

const insertedEnvironment = () =>
  state.calls.find((c) => c.op === "insert" && c.table === schema.environments)
    ?.values as { ownerId: string | null } | undefined;

beforeEach(() => {
  state.orgRole = "member";
  state.projectRole = "contributor";
  state.placements = {
    [SERVER_OPEN]: "open",
    [SERVER_RESTRICTED]: "restricted",
  };
  state.calls = [];
});

describe("createEnvironment placement", () => {
  it("lets a contributor place an environment on open servers", async () => {
    const result = await createEnvironment({
      projectId: PROJECT_ID,
      name: "Dev",
      hasDatabase: false,
      hasFrontend: false,
      ...backend,
    });
    expect(result.success).toBe(true);
    expect(insertedEnvironment()).toBeDefined();
  });

  it("refuses a contributor when any bound server is restricted", async () => {
    await expect(
      createEnvironment({
        projectId: PROJECT_ID,
        name: "Dev",
        hasFrontend: false,
        ...backend,
        ...databaseOn(SERVER_RESTRICTED),
      })
    ).rejects.toMatchObject({ status: 403 });
    expect(insertedEnvironment()).toBeUndefined();
  });

  it("refuses a viewer even on open servers", async () => {
    state.projectRole = "viewer";
    await expect(
      createEnvironment({
        projectId: PROJECT_ID,
        name: "Dev",
        hasDatabase: false,
        hasFrontend: false,
        ...backend,
      })
    ).rejects.toMatchObject({ status: 403 });
    expect(insertedEnvironment()).toBeUndefined();
  });

  it("treats a server it cannot find as restricted", async () => {
    state.placements = {};
    await expect(
      createEnvironment({
        projectId: PROJECT_ID,
        name: "Dev",
        hasDatabase: false,
        hasFrontend: false,
        ...backend,
      })
    ).rejects.toMatchObject({ status: 403 });
  });

  it("keeps today's rule on restricted servers (admin maintainer)", async () => {
    state.orgRole = "admin";
    state.projectRole = "maintainer";
    const result = await createEnvironment({
      projectId: PROJECT_ID,
      name: "Dev",
      hasFrontend: false,
      ...backend,
      ...databaseOn(SERVER_RESTRICTED),
    });
    expect(result.success).toBe(true);
  });

  it("makes the creator the owner when none is given", async () => {
    await createEnvironment({
      projectId: PROJECT_ID,
      name: "Dev",
      hasDatabase: false,
      hasFrontend: false,
      ...backend,
    });
    expect(insertedEnvironment()?.ownerId).toBe(state.userId);
  });

  it("keeps an owner given in the payload", async () => {
    await createEnvironment({
      projectId: PROJECT_ID,
      name: "Dev",
      hasDatabase: false,
      hasFrontend: false,
      ownerId: OWNER_ID,
      ...backend,
    });
    expect(insertedEnvironment()?.ownerId).toBe(OWNER_ID);
  });
});

describe("server placement field", () => {
  it("is accepted by the server schemas with the two values only", () => {
    expect(serverUpdateSchema.parse({ placement: "open" })).toEqual({
      placement: "open",
    });
    expect(serverUpdateSchema.safeParse({ placement: "public" }).success).toBe(
      false
    );
    expect(
      serverInputSchema.safeParse({
        name: "s",
        host: "h",
        username: "u",
        password: "p",
        placement: "restricted",
      }).success
    ).toBe(true);
  });

  it("can only be changed with org server:manage", async () => {
    for (const role of ["member", "observer"]) {
      state.orgRole = role;
      await expect(
        updateServer(SERVER_OPEN, { placement: "open" })
      ).rejects.toMatchObject({ status: 403 });
    }
    expect(state.calls).toEqual([]);
    for (const role of ["admin", "infra"]) {
      state.orgRole = role;
      const result = await updateServer(SERVER_OPEN, { placement: "open" });
      expect(result.success).toBe(true);
    }
  });

  it("changing placement reads and writes no environment rows", async () => {
    state.orgRole = "admin";
    const result = await updateServer(SERVER_OPEN, {
      placement: "restricted",
    });
    expect(result.success).toBe(true);
    expect(state.calls.map((c) => c.op)).toEqual(["update"]);
    expect(state.calls[0]?.table).toBe(schema.servers);
    expect(state.calls[0]?.values).toMatchObject({ placement: "restricted" });
    const touched = state.calls.map((c) => c.table);
    expect(touched).not.toContain(schema.environments);
    expect(touched).not.toContain(schema.environmentServices);
  });
});
