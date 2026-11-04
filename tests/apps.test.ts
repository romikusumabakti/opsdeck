import { beforeEach, describe, expect, it, vi } from "vitest";

const APP_A = "0197f3a0-1b2c-7def-8000-0123456789a1";
const APP_B = "0197f3a0-1b2c-7def-8000-0123456789a2";
const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789e1";

// What the next queries return, in call order. `update` is the conditional
// "set app_id where it is null"; selects read the component, then the env.
const state = vi.hoisted(() => ({
  selectedFields: [] as unknown[],
  listRows: [] as unknown[],
  selects: [] as unknown[][],
  updated: [] as unknown[],
  setValues: [] as unknown[],
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: (fields?: unknown) => {
      state.selectedFields.push(fields);
      return {
        from: () => ({
          where: async () => state.selects.shift() ?? [],
          leftJoin: () => ({ orderBy: async () => state.listRows }),
        }),
      };
    },
    update: () => ({
      set: (values: unknown) => {
        state.setValues.push(values);
        return { where: () => ({ returning: async () => state.updated }) };
      },
    }),
  },
}));

const { assertTargetMatchesEnvironmentApp, listApps } = await import(
  "@/lib/apps"
);

beforeEach(() => {
  state.selects = [];
  state.selectedFields = [];
  state.listRows = [];
  state.updated = [];
  state.setValues = [];
});

describe("assertTargetMatchesEnvironmentApp", () => {
  it("adopts the component's app when the environment has none", async () => {
    state.selects = [[{ appId: APP_A }]];
    state.updated = [{ id: ENV_ID }];
    await expect(
      assertTargetMatchesEnvironmentApp(ENV_ID, "portal-backend")
    ).resolves.toBeUndefined();
    expect(state.setValues).toEqual([{ appId: APP_A }]);
  });

  it("resolves when the environment already has the component's app", async () => {
    state.selects = [[{ appId: APP_A }], [{ appId: APP_A }]];
    await expect(
      assertTargetMatchesEnvironmentApp(ENV_ID, "portal-backend")
    ).resolves.toBeUndefined();
  });

  it("rejects with 409 when the environment belongs to another app", async () => {
    state.selects = [[{ appId: APP_B }], [{ appId: APP_A }]];
    await expect(
      assertTargetMatchesEnvironmentApp(ENV_ID, "other-backend")
    ).rejects.toMatchObject({
      status: 409,
      message: "Component belongs to another app than this environment",
    });
  });
});

describe("listApps", () => {
  it("never selects the encrypted notify secret", async () => {
    state.listRows = [
      {
        app: { id: APP_A, appKey: "a", name: "A" },
        component: { componentKey: "a-backend", appId: APP_A },
      },
      { app: { id: APP_B, appKey: "b", name: "B" }, component: null },
    ];
    const result = await listApps();
    expect(result.map((a) => a.components.length)).toEqual([1, 0]);
    const [fields] = state.selectedFields as [
      { component: Record<string, unknown> },
    ];
    expect(Object.keys(fields.component)).toContain("componentKey");
    expect(Object.keys(fields.component)).not.toContain("notifySecret");
  });
});
