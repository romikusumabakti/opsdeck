import { beforeEach, describe, expect, it, vi } from "vitest";

const APP_A = "0197f3a0-1b2c-7def-8000-0123456789a1";
const APP_B = "0197f3a0-1b2c-7def-8000-0123456789a2";

const state = vi.hoisted(() => ({
  selectedFields: [] as unknown[],
  listRows: [] as unknown[],
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: (fields?: unknown) => {
      state.selectedFields.push(fields);
      return {
        from: () => ({
          leftJoin: () => ({ orderBy: async () => state.listRows }),
        }),
      };
    },
  },
}));

const { listApps } = await import("@/lib/apps");

beforeEach(() => {
  state.selectedFields = [];
  state.listRows = [];
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
