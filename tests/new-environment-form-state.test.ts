import { describe, expect, it } from "vitest";
import type { NewEnvironmentInput } from "@/lib/setup/new-environment";
import {
  changedSince,
  fieldOfCode,
  groupOf,
  parseNewEnvironmentInput,
  snapshotOf,
  visibleIssues,
} from "@/lib/setup/new-environment-form-state";
import { repoPickable } from "../web/routes/$locale/_app/-components/setup/repo-picker";

const PROJECT = "0197f3a0-1b2c-7def-8000-000000000001";
const CI = "0197f3a0-1b2c-7def-8000-000000000007";

const input = (
  over: Partial<NewEnvironmentInput> = {}
): NewEnvironmentInput => ({
  projectId: PROJECT,
  name: "Dev 3",
  repos: [{ ciConnectionId: CI, repoFullName: "dss/a", branch: "main" }],
  needsDatabase: false,
  address: { label: "" },
  ...over,
});

describe("groupOf", () => {
  it("puts each field under the part of the page it is about", () => {
    expect(groupOf("name")).toBe("name");
    expect(groupOf("copyFromEnvironmentId")).toBe("startFrom");
    expect(groupOf("repos.1")).toBe("repos");
    expect(groupOf("targets")).toBe("repos");
    expect(groupOf("serverId")).toBe("server");
    expect(groupOf("server.serverId")).toBe("server");
    expect(groupOf("database.dbName")).toBe("database");
    expect(groupOf("domain.label")).toBe("address");
    expect(groupOf("targets.0.healthUrl")).toBe("advanced");
    expect(groupOf("pipelines.0.buildSpec.branches")).toBe("advanced");
  });
});

describe("fieldOfCode", () => {
  it("maps a refusal's code to its field, else General", () => {
    expect(fieldOfCode("nameTaken")).toBe("name");
    expect(fieldOfCode("environmentNameTaken")).toBe("name");
    expect(fieldOfCode("domainTaken")).toBe("domain.label");
    expect(fieldOfCode("noServerAvailable")).toBe("serverId");
    expect(fieldOfCode("repoUnreadable")).toBe("repos");
    expect(fieldOfCode("placementForbidden")).toBe("general");
  });
});

describe("snapshotOf and changedSince", () => {
  it("tells which part changed", () => {
    const a = snapshotOf(input());
    const b = snapshotOf(input({ name: "Dev 4" }));
    expect(changedSince(b, a, "name")).toBe(true);
    expect(changedSince(b, a, "repos")).toBe(false);
    // An Advanced issue may hang on any part.
    expect(changedSince(b, a, "advanced")).toBe(true);
    expect(changedSince(a, null, "name")).toBe(true);
  });

  it("counts Advanced database and domain with their simple fields", () => {
    const a = snapshotOf(input());
    const b = snapshotOf(input({ advanced: { database: { kind: "none" } } }));
    expect(changedSince(b, a, "database")).toBe(true);
    expect(changedSince(b, a, "address")).toBe(false);
  });
});

describe("parseNewEnvironmentInput", () => {
  it("points zod's issues at the page's fields", () => {
    const parsed = parseNewEnvironmentInput({
      ...input(),
      address: { label: "-bad-" },
      advanced: { targets: [] },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues).toContainEqual({
      field: "domain.label",
      code: "invalid",
    });
    expect(parsed.issues).toContainEqual({ field: "targets", code: "invalid" });
  });
});

describe("visibleIssues", () => {
  const snapshot = snapshotOf(input());
  const base = {
    clientIssues: [],
    checkIssues: [
      { field: "name", code: "environmentNameTaken" },
      { field: "repos.0", code: "repoNotBuildable" },
    ],
    snapshot,
    checked: snapshot,
    submitted: false,
    touched: new Set<never>(),
    noServerKnown: false,
  };

  it("shows nothing before interaction", () => {
    expect(visibleIssues(base)).toEqual([]);
  });

  it("shows a touched part's issues, all after Create", () => {
    expect(
      visibleIssues({ ...base, touched: new Set(["repos"] as const) })
    ).toEqual([{ field: "repos.0", code: "repoNotBuildable" }]);
    expect(visibleIssues({ ...base, submitted: true })).toHaveLength(2);
  });

  it("drops a check's issues for a part changed since", () => {
    expect(
      visibleIssues({
        ...base,
        submitted: true,
        snapshot: snapshotOf(input({ name: "Other" })),
      })
    ).toEqual([{ field: "repos.0", code: "repoNotBuildable" }]);
  });

  it("always shows a missing server", () => {
    expect(visibleIssues({ ...base, noServerKnown: true })).toEqual([
      { field: "serverId", code: "noServerAvailable" },
    ]);
  });
});

describe("repoPickable", () => {
  const row = (repoFullName: string, appKey: string | null) => ({
    repoFullName,
    appKey,
  });
  it("refuses another app's repository and a repeat", () => {
    expect(repoPickable(row("dss/a", "scmb"), [], "scmb")).toBe(true);
    expect(repoPickable(row("dss/h", "hris"), [], "scmb")).toBe(false);
    expect(repoPickable(row("dss/a", "scmb"), ["dss/a"], "scmb")).toBe(false);
  });
  it("refuses any registered repository once a new app's is picked", () => {
    expect(repoPickable(row("dss/a", "scmb"), [], null)).toBe(true);
    expect(repoPickable(row("dss/a", "scmb"), ["dss/new"], null)).toBe(false);
    expect(repoPickable(row("dss/other", null), ["dss/new"], null)).toBe(true);
  });
});
