import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canPlaceEnvironment,
  type OrgPermissions,
  type ProjectRole,
} from "@/lib/permissions";

// Server placement: who may put a new environment on a server. `restricted`
// keeps today's rule (project environment:create + org server:manage); `open`
// admits project maintainers without server:manage, never contributors (QA).
// There, a caller without server:manage may only bind service names that
// start with the project key lowercased plus "-" and that no other environment
// on the server uses. Changing a server's placement only affects later
// placements, never the environments already on it.

const PROJECT_ID = "0197f3a0-1b2c-7def-8000-0123456789f1";
const SERVER_OPEN = "0197f3a0-1b2c-7def-8000-0123456789c1";
const SERVER_RESTRICTED = "0197f3a0-1b2c-7def-8000-0123456789c2";
const OWNER_ID = "0197f3a0-1b2c-7def-8000-0123456789d1";
const TARGET_PROJECT_ID = "0197f3a0-1b2c-7def-8000-0123456789f3";
const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789e1";
const OTHER_ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789e9";

describe("canPlaceEnvironment", () => {
  // [orgRole, projectRole, restricted, open]
  const MATRIX: [string, ProjectRole, boolean, boolean][] = [
    ["admin", "viewer", false, false],
    ["admin", "contributor", false, false],
    ["admin", "maintainer", true, true],
    ["infra", "viewer", false, false],
    ["infra", "contributor", false, false],
    ["infra", "maintainer", true, true],
    ["member", "viewer", false, false],
    ["member", "contributor", false, false],
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
type Service = { role: string; serverId: string; serviceName: string };

const state = vi.hoisted(() => ({
  orgRole: "member" as string,
  // Role in the environment's (or the created environment's) project.
  projectRole: "maintainer" as string | null,
  // Key of the project a placement is checked for (the projects lookup).
  projectKey: "HRIS",
  // Role in the project an update moves the environment into.
  targetProjectRole: "maintainer" as string | null,
  userId: "0197f3a0-1b2c-7def-8000-0123456789a9",
  placements: {} as Record<string, "restricted" | "open">,
  // environment_services rows of every environment (for the in-use check).
  used: [] as (Service & { environmentId: string })[],
  // The environment an update loads.
  stored: { id: "", projectId: "", ownerId: null, services: [] } as {
    id: string;
    projectId: string;
    ownerId: string | null;
    services: Service[];
  },
  // Every requireProjectPermission call: [scope, perms].
  guards: [] as [Record<string, string>, unknown][],
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
  const { canOrg, canProject } = await import("@/lib/permissions");
  return {
    ForbiddenError: real.ForbiddenError,
    getProjectRole: async () => state.projectRole,
    projectScope: () => undefined,
    requireOrgPermission: async (perms: OrgPermissions) => {
      if (!canOrg(state.orgRole, perms)) throw new real.ForbiddenError();
      return { user: { id: state.userId, role: state.orgRole } };
    },
    requireProjectPermission: async (
      scope: Record<string, string>,
      perms: Parameters<typeof canProject>[1]
    ) => {
      state.guards.push([scope, perms]);
      const role =
        scope.projectId === TARGET_PROJECT_ID
          ? state.targetProjectRole
          : state.projectRole;
      if (!role) {
        const { HTTPException } = await import("hono/http-exception");
        throw new HTTPException(404, { message: "Not Found" });
      }
      if (!canProject(role as "viewer", perms)) {
        throw new real.ForbiddenError();
      }
      return {
        session: { user: { id: state.userId, role: state.orgRole } },
        role,
        projectId: scope.projectId ?? PROJECT_ID,
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
vi.mock("@/lib/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/environments")>()),
  loadEnvironmentWithServers: async () => state.stored,
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
    if (table === schema.projects) return [{ key: state.projectKey }];
    if (table === schema.environmentServices) return state.used;
    if (table === schema.environments) {
      return [{ id: "0197f3a0-1b2c-7def-8000-0123456789e1", slug: "taken" }];
    }
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
const { createEnvironment, updateEnvironment } = await import(
  "@/server/services/environments"
);
const { updateServer } = await import("@/server/services/servers");
const { serverInputSchema, serverUpdateSchema } = await import(
  "@/lib/validation"
);

const backend = {
  backendServerId: SERVER_OPEN,
  backendServiceType: "docker",
  backendServiceName: "hris-api",
};
const databaseOn = (serverId: string) => ({
  hasDatabase: true,
  dbServerId: serverId,
  dbServiceType: "docker",
  dbServiceName: "hris-pg",
  dbType: "postgres",
  dbName: "app",
  dbBackupPath: "/backups",
});

const insertedEnvironment = () =>
  state.calls.find((c) => c.op === "insert" && c.table === schema.environments)
    ?.values as { ownerId: string | null } | undefined;

beforeEach(() => {
  state.orgRole = "member";
  state.projectRole = "maintainer";
  state.projectKey = "HRIS";
  state.placements = {
    [SERVER_OPEN]: "open",
    [SERVER_RESTRICTED]: "restricted",
  };
  state.targetProjectRole = "maintainer";
  state.used = [];
  state.stored = {
    id: ENV_ID,
    projectId: PROJECT_ID,
    ownerId: null,
    services: [
      { role: "backend", serverId: SERVER_OPEN, serviceName: "hris-api" },
    ],
  };
  state.guards = [];
  state.calls = [];
});

const newOnOpen = {
  projectId: PROJECT_ID,
  name: "Dev",
  hasDatabase: false,
  hasFrontend: false,
  ...backend,
};

describe("createEnvironment guards", () => {
  it("asks only for project:read on the target project, then placement", async () => {
    await createEnvironment(newOnOpen);
    expect(state.guards).toEqual([
      [{ projectId: PROJECT_ID }, { project: ["read"] }],
    ]);
  });

  it("is a 404 for a project the caller cannot see", async () => {
    state.projectRole = null;
    await expect(createEnvironment(newOnOpen)).rejects.toMatchObject({
      status: 404,
    });
    expect(insertedEnvironment()).toBeUndefined();
  });
});

describe("open placement: service names in use", () => {
  it("refuses a maintainer binding a service another environment uses there", async () => {
    state.used = [
      {
        environmentId: OTHER_ENV_ID,
        role: "backend",
        serverId: SERVER_OPEN,
        serviceName: "hris-api",
      },
    ];
    await expect(createEnvironment(newOnOpen)).rejects.toMatchObject({
      status: 403,
      message: "placementServiceInUse",
    });
    expect(insertedEnvironment()).toBeUndefined();
  });

  it("counts any role's service name, and only on the same server", async () => {
    state.used = [
      {
        environmentId: OTHER_ENV_ID,
        role: "db",
        serverId: SERVER_RESTRICTED,
        serviceName: "hris-api",
      },
    ];
    expect((await createEnvironment(newOnOpen)).success).toBe(true);
    state.used = [
      {
        environmentId: OTHER_ENV_ID,
        role: "frontend",
        serverId: SERVER_OPEN,
        serviceName: "hris-api",
      },
    ];
    await expect(createEnvironment(newOnOpen)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("refuses a service name without the project key prefix", async () => {
    for (const name of ["api", "hris", "hris-", "hrisapi", "other-api"]) {
      state.calls = [];
      await expect(
        createEnvironment({ ...newOnOpen, backendServiceName: name })
      ).rejects.toMatchObject({
        status: 403,
        message: "placementServiceName",
      });
      expect(insertedEnvironment()).toBeUndefined();
    }
  });

  it("checks the prefix on every binding on an open server", async () => {
    await expect(
      createEnvironment({
        ...newOnOpen,
        ...databaseOn(SERVER_OPEN),
        dbServiceName: "dplk-postgres",
      })
    ).rejects.toMatchObject({ status: 403, message: "placementServiceName" });
    expect(
      (
        await createEnvironment({
          ...newOnOpen,
          ...databaseOn(SERVER_OPEN),
        })
      ).success
    ).toBe(true);
  });

  it("uses the key of the project the environment is placed in", async () => {
    state.projectKey = "KESTREL";
    await expect(createEnvironment(newOnOpen)).rejects.toMatchObject({
      status: 403,
      message: "placementServiceName",
    });
    expect(
      (
        await createEnvironment({
          ...newOnOpen,
          backendServiceName: "kestrel-api",
        })
      ).success
    ).toBe(true);
  });

  it("lets a caller with server:manage bind any name", async () => {
    state.orgRole = "infra";
    expect(
      (await createEnvironment({ ...newOnOpen, backendServiceName: "api" }))
        .success
    ).toBe(true);
  });

  it("lets a caller with server:manage share a service name", async () => {
    state.orgRole = "infra";
    state.projectRole = "maintainer";
    state.used = [
      {
        environmentId: OTHER_ENV_ID,
        role: "backend",
        serverId: SERVER_OPEN,
        serviceName: "hris-api",
      },
    ];
    expect((await createEnvironment(newOnOpen)).success).toBe(true);
  });
});

describe("updateEnvironment placement", () => {
  const updates = () => state.calls.filter((c) => c.op === "update");

  it("refuses moving an environment on a restricted server without server:manage", async () => {
    // Maintainer of both projects, org member: may update here, may create
    // environments there, but not place one on a restricted server.
    state.projectRole = "maintainer";
    state.targetProjectRole = "maintainer";
    state.stored.services = [
      { role: "backend", serverId: SERVER_RESTRICTED, serviceName: "hris-api" },
    ];
    await expect(
      updateEnvironment(ENV_ID, { projectId: TARGET_PROJECT_ID })
    ).rejects.toMatchObject({ status: 403 });
    expect(updates()).toEqual([]);
    expect(state.guards).toContainEqual([
      { projectId: TARGET_PROJECT_ID },
      { project: ["read"] },
    ]);
  });

  it("lets admins move it (restricted rule satisfied)", async () => {
    state.orgRole = "admin";
    state.projectRole = "maintainer";
    state.targetProjectRole = "maintainer";
    state.stored.services = [
      { role: "backend", serverId: SERVER_RESTRICTED, serviceName: "hris-api" },
    ];
    const result = await updateEnvironment(ENV_ID, {
      projectId: TARGET_PROJECT_ID,
    });
    expect(result.success).toBe(true);
  });

  it("judges a move by the role in the target project", async () => {
    state.projectRole = "maintainer";
    state.targetProjectRole = "viewer";
    await expect(
      updateEnvironment(ENV_ID, { projectId: TARGET_PROJECT_ID })
    ).rejects.toMatchObject({ status: 403 });
    state.targetProjectRole = "contributor";
    await expect(
      updateEnvironment(ENV_ID, { projectId: TARGET_PROJECT_ID })
    ).rejects.toMatchObject({ status: 403 });
    state.targetProjectRole = "maintainer";
    // Open server, own service rows do not count as "in use".
    state.used = [
      {
        environmentId: ENV_ID,
        role: "backend",
        serverId: SERVER_OPEN,
        serviceName: "hris-api",
      },
    ];
    expect(
      (await updateEnvironment(ENV_ID, { projectId: TARGET_PROJECT_ID }))
        .success
    ).toBe(true);
  });

  it("refuses a move onto an open server whose service another environment shares", async () => {
    state.projectRole = "maintainer";
    state.used = [
      {
        environmentId: OTHER_ENV_ID,
        role: "backend",
        serverId: SERVER_OPEN,
        serviceName: "hris-api",
      },
    ];
    await expect(
      updateEnvironment(ENV_ID, { projectId: TARGET_PROJECT_ID })
    ).rejects.toMatchObject({ status: 403, message: "placementServiceInUse" });
    expect(updates()).toEqual([]);
  });

  it("does not re-check placement when the project id is re-sent unchanged", async () => {
    state.projectRole = "maintainer";
    state.stored.services = [
      { role: "backend", serverId: SERVER_RESTRICTED, serviceName: "hris-api" },
    ];
    const result = await updateEnvironment(ENV_ID, {
      projectId: PROJECT_ID,
      name: "Renamed",
    });
    expect(result.success).toBe(true);
  });

  it("refuses a service-name change without server:manage", async () => {
    state.projectRole = "maintainer";
    await expect(
      updateEnvironment(ENV_ID, { backendServiceName: "hris-api-2" })
    ).rejects.toMatchObject({ status: 403 });
    expect(updates()).toEqual([]);
  });

  it("checks placement of a binding change (restricted rule for infra)", async () => {
    state.orgRole = "infra";
    state.projectRole = "maintainer";
    const result = await updateEnvironment(ENV_ID, {
      backendServerId: SERVER_RESTRICTED,
    });
    expect(result).toMatchObject({ success: true });
    // The placement lookup ran against the servers table.
    expect(
      state.calls.some((c) => c.op === "select" && c.table === schema.servers)
    ).toBe(true);
  });
});

describe("createEnvironment placement", () => {
  it("refuses a contributor even on open servers", async () => {
    state.projectRole = "contributor";
    await expect(createEnvironment(newOnOpen)).rejects.toMatchObject({
      status: 403,
    });
    expect(insertedEnvironment()).toBeUndefined();
  });

  it("lets a maintainer without server:manage place an environment on open servers", async () => {
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

  it("refuses a maintainer without server:manage when any bound server is restricted", async () => {
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
