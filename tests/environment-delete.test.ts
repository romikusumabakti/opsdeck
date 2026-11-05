import { beforeEach, describe, expect, it, vi } from "vitest";

// Deleting an environment cascades to its variables. Escrowed ones (e.g. the
// HRIS DATA_ENCRYPTION_KEY) exist nowhere else, so a delete is refused (409)
// while the environment has any, unless an admin with org
// integration:manage confirms it explicitly. Every delete that removes
// variables leaves an activity entry (names and count, never values).

const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789e1";
const USER_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";

const state = vi.hoisted(() => ({
  orgRole: "member" as string,
  variables: [] as { name: string; escrow: boolean }[],
  // Rows the DELETE … RETURNING yields (empty: nothing matched).
  deleted: [] as { name: string }[],
  deletes: 0,
  activity: [] as unknown[],
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: async () => ({ user: { id: USER_ID, role: state.orgRole } }),
  getServerSession: async () => ({
    user: { id: USER_ID, role: state.orgRole },
  }),
}));
vi.mock("@/lib/authz", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/authz")>();
  return {
    ForbiddenError: real.ForbiddenError,
    getProjectRole: async () => "maintainer",
    projectScope: () => undefined,
    requireOrgPermission: async () => undefined,
    requireProjectPermission: async () => ({
      session: { user: { id: USER_ID, role: state.orgRole } },
      role: "maintainer",
      projectId: "0197f3a0-1b2c-7def-8000-0123456789f1",
    }),
  };
});
vi.mock("@/lib/activity", () => ({
  recordActivity: async (entry: unknown) => {
    state.activity.push(entry);
  },
}));
vi.mock("@/lib/secrets", () => ({
  encryptNullable: (v: string | null | undefined) => v ?? null,
}));
vi.mock("@/server/i18n", () => ({
  getServerTranslator: async () => (key: string) => key,
}));

vi.mock("@/lib/db", async () => {
  const schema = await import("@/lib/db/schema");
  const rowsFor = (table: unknown): unknown[] => {
    if (table === schema.environments) return [{ name: "HRIS Dev" }];
    if (table === schema.environmentVariables) return state.variables;
    return [];
  };
  // biome-ignore lint/suspicious/noExplicitAny: self-referential mock builder
  const select = (): any => {
    let table: unknown;
    // biome-ignore lint/suspicious/noExplicitAny: self-referential mock builder
    const chain: any = {
      from: (t: unknown) => {
        table = t;
        return chain;
      },
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      // biome-ignore lint/suspicious/noThenProperty: awaitable query builder
      then: (resolve: (rows: unknown[]) => unknown, reject: () => unknown) =>
        Promise.resolve(rowsFor(table)).then(resolve, reject),
    };
    return chain;
  };
  return {
    db: {
      select,
      delete: () => {
        state.deletes++;
        return {
          where: () => ({ returning: async () => state.deleted }),
        };
      },
    },
  };
});

const { deleteEnvironment } = await import("@/server/services/environments");

beforeEach(() => {
  state.orgRole = "member";
  state.variables = [];
  state.deleted = [{ name: "HRIS Dev" }];
  state.deletes = 0;
  state.activity = [];
});

describe("deleteEnvironment and escrowed variables", () => {
  it("deletes an environment without variables and records nothing", async () => {
    expect(await deleteEnvironment(ENV_ID)).toMatchObject({ success: true });
    expect(state.deletes).toBe(1);
    expect(state.activity).toEqual([]);
  });

  it("refuses (409) while the environment has escrowed variables", async () => {
    state.variables = [
      { name: "APP_NAME", escrow: false },
      { name: "DATA_ENCRYPTION_KEY", escrow: true },
    ];
    for (const options of [{}, { confirmEscrowedDeletion: false }]) {
      await expect(deleteEnvironment(ENV_ID, options)).rejects.toMatchObject({
        status: 409,
        message: "environmentHasEscrowedVariables",
      });
    }
    expect(state.deletes).toBe(0);
    expect(state.activity).toEqual([]);
  });

  it("refuses the confirmation from a caller without integration:manage", async () => {
    state.variables = [{ name: "DATA_ENCRYPTION_KEY", escrow: true }];
    for (const role of ["member", "infra", "observer"]) {
      state.orgRole = role;
      await expect(
        deleteEnvironment(ENV_ID, { confirmEscrowedDeletion: true })
      ).rejects.toMatchObject({ status: 409 });
    }
    expect(state.deletes).toBe(0);
  });

  it("lets an admin delete it with the explicit confirmation, and records it", async () => {
    state.orgRole = "admin";
    state.variables = [
      { name: "APP_NAME", escrow: false },
      { name: "DATA_ENCRYPTION_KEY", escrow: true },
    ];
    await expect(deleteEnvironment(ENV_ID)).rejects.toMatchObject({
      status: 409,
    });
    expect(
      await deleteEnvironment(ENV_ID, { confirmEscrowedDeletion: true })
    ).toMatchObject({ success: true });
    expect(state.deletes).toBe(1);
    expect(state.activity).toEqual([
      {
        actorId: USER_ID,
        action: "environment.deletedWithVariables",
        entityType: "environment",
        entityId: ENV_ID,
        data: {
          environment: "HRIS Dev",
          count: 2,
          names: "APP_NAME, DATA_ENCRYPTION_KEY",
        },
      },
    ]);
  });

  it("records a delete that removes plain variables only", async () => {
    state.variables = [{ name: "APP_NAME", escrow: false }];
    expect(await deleteEnvironment(ENV_ID)).toMatchObject({ success: true });
    expect(state.activity).toHaveLength(1);
    expect(JSON.stringify(state.activity)).toContain('"count":1');
  });

  it("answers 409 when a variable was escrowed between the check and the delete", async () => {
    state.variables = [{ name: "APP_NAME", escrow: false }];
    // The conditional DELETE matched nothing although the row exists.
    state.deleted = [];
    await expect(deleteEnvironment(ENV_ID)).rejects.toMatchObject({
      status: 409,
    });
    expect(state.activity).toEqual([]);
  });
});
