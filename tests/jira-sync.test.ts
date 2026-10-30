import { describe, expect, it } from "vitest";
import { buildSweepJql } from "@/lib/jira/sync";

/**
 * The sweep query is the contract that makes syncing resumable and idempotent,
 * so it is pinned here: always ordered by `updated` ascending, always scoped to
 * the project, and rewound five minutes behind the stored cursor.
 */
describe("buildSweepJql", () => {
  const base = {
    jiraProjectKey: "CMEM",
    jqlFilter: null,
    lastSyncAt: null,
  };

  it("scopes to the project and orders by updated ascending", () => {
    expect(buildSweepJql(base)).toBe('project = "CMEM" ORDER BY updated ASC');
  });

  it("AND-s the extra filter in its own parentheses", () => {
    expect(
      buildSweepJql({ ...base, jqlFilter: "labels = opsdeck OR x = 1" })
    ).toBe(
      'project = "CMEM" AND (labels = opsdeck OR x = 1) ORDER BY updated ASC'
    );
  });

  it("ignores a blank filter rather than emitting empty parentheses", () => {
    expect(buildSweepJql({ ...base, jqlFilter: "   " })).toBe(
      'project = "CMEM" ORDER BY updated ASC'
    );
  });

  it("rewinds the cursor five minutes — JQL `updated` is minute-granular", () => {
    const lastSyncAt = new Date("2026-08-11T10:20:00.000Z");
    expect(buildSweepJql({ ...base, lastSyncAt })).toBe(
      'project = "CMEM" AND updated >= "2026/08/11 10:15" ORDER BY updated ASC'
    );
  });

  it("omits the cursor entirely on a full re-import", () => {
    const lastSyncAt = new Date("2026-08-11T10:20:00.000Z");
    expect(buildSweepJql({ ...base, lastSyncAt }, { full: true })).toBe(
      'project = "CMEM" ORDER BY updated ASC'
    );
  });

  it("escapes a quote in the project key so the clause can't be broken open", () => {
    expect(buildSweepJql({ ...base, jiraProjectKey: 'A"B' })).toContain(
      'project = "A\\"B"'
    );
  });
});
