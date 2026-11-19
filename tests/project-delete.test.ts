import { beforeEach, describe, expect, it, vi } from "vitest";

// Deleting a project cascades to its environments and their variables.
// Escrowed ones exist nowhere else, so the delete is refused (409) while any
// environment of the project has them, unless an admin with org
// integration:manage confirms it. Every environment that loses variables
// leaves an activity entry (names and count, never values). Releases are
// never cascaded (their files live in Garage): a project with releases is
// refused (409 projectHasReleases) for everyone until they are deleted.

const PROJECT_ID = "0197f3a0-1b2c-7def-8000-0123456789f1";
const ENV_A = "0197f3a0-1b2c-7def-8000-0123456789e1";
const ENV_B = "0197f3a0-1b2c-7def-8000-0123456789e2";
const USER_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";

const state = vi.hoisted(() => ({
  orgRole: "admin" as string,
  rows: [] as {
    environmentId: string;
    environment: string;
    name: string;
    escrow: boolean;
  }[],
  releases: [] as { id: string }[],
  // Services with a recorded Assistant database login.
  logins: [] as { id: string }[],
  // After the guarded delete matched nothing (a login recorded since).
  loginsAfter: null as { id: string }[] | null,
  environments: [] as { id: string }[],
  locked: [] as string[],
  deleted: [] as { id: string }[],
  deleteError: null as unknown,
  deletes: 0,
  activity: [] as unknown[],
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: async () => ({
    user: { id: USER_ID, role: state.orgRole },
    session: { signInMethod: "passkey" },
  }),
}));
vi.mock("@/lib/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authz")>()),
  projectIdsWhere: () => undefined,
  projectScope: () => undefined,
  getProjectRole: async () => "engineer",
  requireProjectPermission: async () => undefined,
  requireOrgPermission: async () => ({
    user: { id: USER_ID, role: state.orgRole },
    session: { signInMethod: "passkey" },
  }),
}));
vi.mock("@/lib/activity", () => ({
  recordActivity: async (entry: unknown) => {
    state.activity.push(entry);
  },
}));
vi.mock("@/server/i18n", () => ({
  getServerTranslator: async () => (key: string) => key,
}));
vi.mock("@/lib/db", async () => {
  const { releases, environmentServices, environments } = await import(
    "@/lib/db/schema"
  );
  // A select on releases answers state.releases, on environment_services
  // state.logins, on environments state.environments, any other state.rows.
  const answer = (table: unknown) => {
    if (table === releases) return state.releases;
    if (table === environmentServices) {
      return state.deletes > 0 && state.loginsAfter
        ? state.loginsAfter
        : state.logins;
    }
    if (table === environments) return state.environments;
    return state.rows;
  };
  const select = () => {
    let table: unknown;
    // biome-ignore lint/suspicious/noExplicitAny: self-referential mock builder
    const chain: any = {
      from: (t: unknown) => {
        table = t;
        return chain;
      },
      innerJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      // biome-ignore lint/suspicious/noThenProperty: awaitable query builder
      then: (resolve: (rows: unknown[]) => unknown, reject: () => unknown) =>
        Promise.resolve(answer(table)).then(resolve, reject),
    };
    return chain;
  };
  const remove = () => {
    state.deletes++;
    return {
      where: () => ({
        returning: async () => {
          if (state.deleteError) throw state.deleteError;
          return state.deleted;
        },
      }),
    };
  };
  const tx = {
    select,
    delete: remove,
    // The environment locks (pg_advisory_xact_lock on each id).
    execute: async (query: { queryChunks?: unknown[] }) => {
      const id = JSON.stringify(query.queryChunks ?? "").match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/
      )?.[0];
      if (id) state.locked.push(id);
      return [];
    },
  };
  return {
    db: {
      select,
      delete: remove,
      transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    },
  };
});

const { removeProject } = await import("@/server/services/project-catalog");

beforeEach(() => {
  state.orgRole = "admin";
  state.rows = [];
  state.releases = [];
  state.logins = [];
  state.loginsAfter = null;
  state.environments = [];
  state.locked = [];
  state.deleted = [{ id: PROJECT_ID }];
  state.deleteError = null;
  state.deletes = 0;
  state.activity = [];
});

describe("removeProject and escrowed variables", () => {
  it("deletes a project without variables and records nothing", async () => {
    expect(await removeProject(PROJECT_ID)).toMatchObject({ success: true });
    expect(state.deletes).toBe(1);
    expect(state.activity).toEqual([]);
  });

  it("refuses (409) while an environment has escrowed variables", async () => {
    state.rows = [
      { environmentId: ENV_A, environment: "Dev", name: "KEY", escrow: true },
    ];
    for (const options of [{}, { confirmEscrowedDeletion: false }]) {
      await expect(removeProject(PROJECT_ID, options)).rejects.toMatchObject({
        status: 409,
        message: "projectHasEscrowedVariables",
      });
    }
    expect(state.deletes).toBe(0);
    expect(state.activity).toEqual([]);
  });

  it("ignores the confirmation from a caller without integration:manage", async () => {
    state.rows = [
      { environmentId: ENV_A, environment: "Dev", name: "KEY", escrow: true },
    ];
    state.orgRole = "engineer";
    await expect(
      removeProject(PROJECT_ID, { confirmEscrowedDeletion: true })
    ).rejects.toMatchObject({ status: 409 });
    expect(state.deletes).toBe(0);
  });

  it("refuses when the guarded delete matches nothing (escrowed since the check)", async () => {
    state.rows = [
      { environmentId: ENV_A, environment: "Dev", name: "APP", escrow: false },
    ];
    state.deleted = [];
    await expect(removeProject(PROJECT_ID)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("lets an admin confirm, and records one entry per environment", async () => {
    state.rows = [
      { environmentId: ENV_A, environment: "Dev", name: "APP", escrow: false },
      { environmentId: ENV_A, environment: "Dev", name: "KEY", escrow: true },
      {
        environmentId: ENV_B,
        environment: "Prod",
        name: "TOKEN",
        escrow: false,
      },
    ];
    expect(
      await removeProject(PROJECT_ID, { confirmEscrowedDeletion: true })
    ).toMatchObject({ success: true });
    expect(state.deletes).toBe(1);
    expect(state.activity).toEqual([
      {
        actorId: USER_ID,
        action: "environment.deletedWithVariables",
        entityType: "environment",
        entityId: ENV_A,
        data: { environment: "Dev", count: 2, names: "APP, KEY" },
      },
      {
        actorId: USER_ID,
        action: "environment.deletedWithVariables",
        entityType: "environment",
        entityId: ENV_B,
        data: { environment: "Prod", count: 1, names: "TOKEN" },
      },
    ]);
  });

  it("deletes without confirmation when no variable is escrowed, and still records", async () => {
    state.rows = [
      {
        environmentId: ENV_B,
        environment: "Prod",
        name: "TOKEN",
        escrow: false,
      },
    ];
    expect(await removeProject(PROJECT_ID)).toMatchObject({ success: true });
    expect(state.activity).toHaveLength(1);
  });
});

describe("removeProject and releases", () => {
  it("refuses (409 projectHasReleases) while the project has releases, even for an admin confirming escrow", async () => {
    state.releases = [{ id: "0197f3a0-1b2c-7def-8000-0123456789c1" }];
    state.rows = [
      { environmentId: ENV_A, environment: "Dev", name: "KEY", escrow: true },
    ];
    for (const options of [{}, { confirmEscrowedDeletion: true }]) {
      await expect(removeProject(PROJECT_ID, options)).rejects.toMatchObject({
        status: 409,
        code: "projectHasReleases",
        message: "projectHasReleases",
      });
    }
    expect(state.deletes).toBe(0);
    expect(state.activity).toEqual([]);
  });

  it("refuses when a release appeared after the check (the RESTRICT foreign key)", async () => {
    state.deleteError = Object.assign(new Error("fk"), { code: "23001" });
    await expect(removeProject(PROJECT_ID)).rejects.toMatchObject({
      status: 409,
      code: "projectHasReleases",
    });
  });

  it("deletes a project without releases", async () => {
    expect(await removeProject(PROJECT_ID)).toMatchObject({ success: true });
    expect(state.deletes).toBe(1);
  });

  it("codes the escrow refusal so the client tells the two 409s apart", async () => {
    state.rows = [
      { environmentId: ENV_A, environment: "Dev", name: "KEY", escrow: true },
    ];
    await expect(removeProject(PROJECT_ID)).rejects.toMatchObject({
      status: 409,
      code: "projectHasEscrowedVariables",
    });
  });
});

describe("removeProject and Assistant database logins", () => {
  it("refuses (409 projectHasAssistantDbLogins) while an environment records a login, even for an admin confirming escrow", async () => {
    state.logins = [{ id: "0197f3a0-1b2c-7def-8000-0123456789d1" }];
    state.rows = [
      { environmentId: ENV_A, environment: "Dev", name: "KEY", escrow: true },
    ];
    for (const options of [{}, { confirmEscrowedDeletion: true }]) {
      await expect(removeProject(PROJECT_ID, options)).rejects.toMatchObject({
        status: 409,
        code: "projectHasAssistantDbLogins",
        message: "projectHasAssistantDbLogins",
      });
    }
    expect(state.deletes).toBe(0);
  });

  it("refuses when a login was recorded after the check (the guarded delete matched nothing)", async () => {
    state.deleted = [];
    state.loginsAfter = [{ id: "0197f3a0-1b2c-7def-8000-0123456789d1" }];
    await expect(removeProject(PROJECT_ID)).rejects.toMatchObject({
      status: 409,
      code: "projectHasAssistantDbLogins",
    });
    expect(state.deletes).toBe(1);
  });

  it("holds every environment's lock exclusively, in id order, before deleting", async () => {
    state.environments = [{ id: ENV_A }, { id: ENV_B }];
    expect(await removeProject(PROJECT_ID)).toMatchObject({ success: true });
    expect(state.locked).toEqual([ENV_A, ENV_B]);
  });
});
