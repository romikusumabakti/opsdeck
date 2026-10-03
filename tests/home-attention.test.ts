import { describe, expect, it } from "bun:test";
import {
  attentionKey,
  ERROR_EXCERPT_MAX,
  type FailureRow,
  failurePrefill,
  groupFailures,
} from "@/lib/home/attention";

const at = (iso: string) => new Date(iso);

function failure(over: Partial<FailureRow> = {}): FailureRow {
  return {
    id: crypto.randomUUID(),
    environmentId: "env-a",
    kind: "restore",
    description: "Restore database dplk",
    errorMessage: "boom",
    runAt: at("2026-10-03T10:00:00Z"),
    environmentName: "Sucor Dev",
    envPath: "/SCMB/dev",
    projectId: "p1",
    ...over,
  };
}

describe("attentionKey", () => {
  it("uses the kind when present", () => {
    expect(attentionKey({ kind: "backup", description: "x" })).toBe("backup");
  });
  it("falls back to the description for legacy runs", () => {
    expect(attentionKey({ kind: null, description: "Backup db" })).toBe(
      "Backup db"
    );
  });
});

describe("groupFailures", () => {
  it("collapses repeats of one key in one environment into a counted group", () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      failure({ runAt: at(`2026-10-0${i + 1}T10:00:00Z`) })
    );
    const groups = groupFailures(rows, []);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.count).toBe(6);
    expect(groups[0]!.latest.runAt).toEqual(at("2026-10-06T10:00:00Z"));
  });

  it("keeps the same key in two environments apart", () => {
    const groups = groupFailures(
      [failure(), failure({ environmentId: "env-b", envPath: "/SCMB/qa" })],
      []
    );
    expect(groups).toHaveLength(2);
  });

  it("keeps different kinds in one environment apart", () => {
    const groups = groupFailures(
      [failure(), failure({ kind: "backup", description: "Backup db" })],
      []
    );
    expect(groups.map((g) => g.key).sort()).toEqual(["backup", "restore"]);
  });

  it("drops a group once a later success with the same key exists", () => {
    const groups = groupFailures(
      [failure({ runAt: at("2026-10-03T10:00:00Z") })],
      [
        {
          environmentId: "env-a",
          key: "restore",
          runAt: at("2026-10-03T11:00:00Z"),
        },
      ]
    );
    expect(groups).toEqual([]);
  });

  it("keeps a group whose latest failure is newer than the last success", () => {
    const groups = groupFailures(
      [failure({ runAt: at("2026-10-03T12:00:00Z") })],
      [
        {
          environmentId: "env-a",
          key: "restore",
          runAt: at("2026-10-03T11:00:00Z"),
        },
      ]
    );
    expect(groups).toHaveLength(1);
  });

  it("ignores successes of another kind or another environment", () => {
    const groups = groupFailures(
      [failure()],
      [
        {
          environmentId: "env-a",
          key: "backup",
          runAt: at("2026-10-04T00:00:00Z"),
        },
        {
          environmentId: "env-b",
          key: "restore",
          runAt: at("2026-10-04T00:00:00Z"),
        },
      ]
    );
    expect(groups).toHaveLength(1);
  });

  it("groups legacy kind-less runs by description", () => {
    const groups = groupFailures(
      [
        failure({ kind: null, description: "Backup db (a)" }),
        failure({ kind: null, description: "Backup db (a)" }),
        failure({ kind: null, description: "Backup db (b)" }),
      ],
      []
    );
    expect(groups.map((g) => [g.key, g.count]).sort()).toEqual([
      ["Backup db (a)", 2],
      ["Backup db (b)", 1],
    ]);
  });

  it("orders newest first and caps at the limit, regardless of input order", () => {
    const rows = [
      failure({ environmentId: "e1", runAt: at("2026-10-01T00:00:00Z") }),
      failure({ environmentId: "e3", runAt: at("2026-10-03T00:00:00Z") }),
      failure({ environmentId: "e2", runAt: at("2026-10-02T00:00:00Z") }),
    ];
    expect(groupFailures(rows, [], 2).map((g) => g.environmentId)).toEqual([
      "e3",
      "e2",
    ]);
  });
});

describe("failurePrefill", () => {
  const group = {
    latest: { description: "Restore database dplk", errorMessage: "boom" },
    envPath: "/SCMB/dev",
  };

  it("builds a bug with the error in a code block and a history link", () => {
    const p = failurePrefill(group, "Restore failed: Sucor Dev", "Run history");
    expect(p.type).toBe("bug");
    expect(p.title).toBe("Restore failed: Sucor Dev");
    expect(p.description).toBe(
      "Restore database dplk\n\n```\nboom\n```\n\n[Run history](/SCMB/dev/history)"
    );
  });

  it("omits the code block when there is no error message", () => {
    const p = failurePrefill(
      { ...group, latest: { ...group.latest, errorMessage: null } },
      "t",
      "Run history"
    );
    expect(p.description).not.toContain("```");
  });

  it("truncates long errors with an ellipsis", () => {
    const long = "x".repeat(ERROR_EXCERPT_MAX + 50);
    const p = failurePrefill(
      { ...group, latest: { ...group.latest, errorMessage: long } },
      "t",
      "Run history"
    );
    expect(p.description).toContain(`${"x".repeat(ERROR_EXCERPT_MAX)}…`);
    expect(p.description).not.toContain("x".repeat(ERROR_EXCERPT_MAX + 1));
  });

  it("uses a longer fence when the error itself contains backticks", () => {
    const p = failurePrefill(
      { ...group, latest: { ...group.latest, errorMessage: "a ``` b" } },
      "t",
      "Run history"
    );
    expect(p.description).toContain("````\na ``` b\n````");
  });

  it("caps the title at 300 characters", () => {
    expect(failurePrefill(group, "y".repeat(400), "l").title).toHaveLength(300);
  });
});
