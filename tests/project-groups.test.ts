import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { locales } from "@/i18n/locales";
import { canManageProjectGroups } from "@/lib/permissions";

// Project groups without a database: who may manage them (the refusal comes
// before any query), the coded refusals, the routes' session gate and the
// wording in every locale. tests/project-groups-scratch.test.ts runs the
// service against Postgres.

const USER_ID = "0197f3a0-1b2c-7def-8000-0123456789a9";
const A = "0197f3a0-1b2c-7def-8000-0123456789b1";
const B = "0197f3a0-1b2c-7def-8000-0123456789b2";

const state = vi.hoisted(() => ({ orgRole: "engineer" as string, queries: 0 }));

vi.mock("@/lib/auth-session", () => {
  const current = async () => ({
    user: { id: USER_ID, name: "Rina", role: state.orgRole },
    session: { signInMethod: "passkey" },
  });
  return { requireSession: current, getServerSession: current };
});
// Any query fails the test: every refusal here must come before the database.
vi.mock("@/lib/db", () => ({
  db: new Proxy(
    {},
    {
      get() {
        state.queries++;
        throw new Error("database reached");
      },
    }
  ),
}));

const svc = await import("@/server/services/project-groups");

beforeEach(() => {
  state.orgRole = "engineer";
  state.queries = 0;
});

async function refusal(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    const e = error as { status?: number; code?: string };
    return { status: e.status, code: e.code };
  }
  throw new Error("expected a refusal");
}

describe("managing project groups", () => {
  it("is the org project:create right: admin only", () => {
    expect(canManageProjectGroups("admin")).toBe(true);
    for (const role of [
      "infra",
      "engineer",
      "qa",
      "ba",
      "pm",
      "staff",
      "observer",
      null,
    ]) {
      expect(canManageProjectGroups(role), String(role)).toBe(false);
    }
  });

  for (const role of ["infra", "engineer", "qa", "observer", "staff"]) {
    it(`refuses ${role} before touching the database`, async () => {
      state.orgRole = role;
      for (const call of [
        svc.createGroup({ name: "Acme" }),
        svc.renameGroup(A, { name: "Acme" }),
        svc.reorderGroup(A, { before: B }),
        svc.mergeGroups({ from: A, into: B }),
        svc.deleteGroup(A),
      ]) {
        expect((await refusal(call)).status).toBe(403);
      }
      expect(state.queries).toBe(0);
    });
  }

  it("refuses merging a group into itself with a coded 400", async () => {
    state.orgRole = "admin";
    expect(await refusal(svc.mergeGroups({ from: A, into: A }))).toEqual({
      status: 400,
      code: "groupMergeSelf",
    });
    expect(state.queries).toBe(0);
  });

  it("refuses a blank or over-long name before the database", async () => {
    state.orgRole = "admin";
    for (const name of ["   ", "x".repeat(81)]) {
      expect((await refusal(svc.createGroup({ name }))).status).toBe(400);
      expect((await refusal(svc.renameGroup(A, { name }))).status).toBe(400);
    }
    expect(state.queries).toBe(0);
  });

  it("refuses a reorder with no neighbour or itself as one", async () => {
    state.orgRole = "admin";
    expect((await refusal(svc.reorderGroup(A, {}))).status).toBe(400);
    expect((await refusal(svc.reorderGroup(A, { after: A }))).status).toBe(400);
    expect(state.queries).toBe(0);
  });

  it("lists groups only for roles that work with projects", async () => {
    state.orgRole = "staff";
    expect((await refusal(svc.listGroups())).status).toBe(403);
  });
});

type Catalog = {
  actionErrors: Record<string, string>;
  activity: Record<string, string>;
};
const catalog = (locale: string): Catalog =>
  JSON.parse(readFileSync(`messages/${locale}.json`, "utf8"));

const ERROR_KEYS = [
  "groupNameTaken",
  "groupNotFound",
  "groupMergeSelf",
  "groupReorderInvalid",
  "projectGroupForbidden",
] as const;

const ACTIVITY_KEYS: Record<string, string[]> = {
  projectGroupCreated: ["{actor}", "{group}"],
  projectGroupRenamed: ["{actor}", "{from}", "{to}"],
  projectGroupMerged: ["{actor}", "{from}", "{into}", "{count"],
  projectGroupDeleted: ["{actor}", "{group}", "{count"],
  projectGroupReordered: ["{actor}", "{group}"],
  projectGroupSet: ["{actor}", "{project}", "{group}"],
  projectGroupCleared: ["{actor}", "{project}"],
};

describe("project groups messages", () => {
  const en = catalog("en");
  for (const locale of locales) {
    it(`${locale} has the refusals and the activity sentences`, () => {
      const own = catalog(locale);
      for (const key of ERROR_KEYS) {
        expect(own.actionErrors[key]?.trim(), key).toBeTruthy();
      }
      for (const [key, params] of Object.entries(ACTIVITY_KEYS)) {
        for (const param of params) {
          expect(own.activity[key], `${key} ${param}`).toContain(param);
        }
      }
    });
  }

  it("id is translated, not a copy of en", () => {
    const id = catalog("id");
    for (const key of ERROR_KEYS) {
      expect(id.actionErrors[key], key).not.toBe(en.actionErrors[key]);
    }
  });

  it("the activity page renders every group action", () => {
    const page = readFileSync(
      "web/routes/$locale/_app/admin.activity.tsx",
      "utf8"
    );
    for (const action of [
      "projectGroup.created",
      "projectGroup.renamed",
      "projectGroup.merged",
      "projectGroup.deleted",
      "projectGroup.reordered",
      "project.groupChanged",
    ]) {
      expect(page).toContain(`case "${action}"`);
    }
  });
});
