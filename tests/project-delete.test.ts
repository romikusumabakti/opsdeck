import { beforeEach, describe, expect, it, vi } from "vitest";

// Deleting a project cascades to its environments and their variables.
// Escrowed ones exist nowhere else, so the delete is refused (409) while any
// environment of the project has them, unless an admin with org
// integration:manage confirms it. Every environment that loses variables
// leaves an activity entry (names and count, never values).

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
  deleted: [] as { id: string }[],
  deletes: 0,
  activity: [] as unknown[],
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: async () => ({ user: { id: USER_ID, role: state.orgRole } }),
}));
vi.mock("@/lib/authz", () => ({
  projectIdsWhere: () => undefined,
  projectScope: () => undefined,
  getProjectRole: async () => "engineer",
  requireProjectPermission: async () => undefined,
  requireOrgPermission: async () => ({
    user: { id: USER_ID, role: state.orgRole },
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
vi.mock("@/lib/db", () => {
  // biome-ignore lint/suspicious/noExplicitAny: self-referential mock builder
  const chain: any = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    // biome-ignore lint/suspicious/noThenProperty: awaitable query builder
    then: (resolve: (rows: unknown[]) => unknown, reject: () => unknown) =>
      Promise.resolve(state.rows).then(resolve, reject),
  };
  return {
    db: {
      select: () => chain,
      delete: () => {
        state.deletes++;
        return { where: () => ({ returning: async () => state.deleted }) };
      },
    },
  };
});

const { removeProject } = await import("@/server/services/project-catalog");

beforeEach(() => {
  state.orgRole = "admin";
  state.rows = [];
  state.deleted = [{ id: PROJECT_ID }];
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
    state.orgRole = "member";
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
