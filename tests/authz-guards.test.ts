import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

// Cross-project reads must filter to the caller's projects. The DB lookups are
// thin, so the cheapest durable check is structural: each listed function must
// mention one of the scope helpers. Add a function here when you add a
// cross-project read.
const SCOPED_READS: Record<string, string[]> = {
  "actions/project-catalog.ts": [
    "listProjects",
    "listProjectsWithEnvironments",
    "getProject",
    "getProjectWithEnvironments",
    "getProjectByKeyWithEnvironments",
  ],
  "actions/environments.ts": [
    "listEnvironments",
    "getEnvironmentsLastOpened",
    "getEnvironmentById",
  ],
  "actions/issues.ts": [
    "getOpenIssueCounts",
    "getAssignedIssueCounts",
    "listAssignedIssues",
    "getIssueDetail",
    "listAllIssues",
    "listIssues",
  ],
  "actions/runs.ts": [
    "getEnvironmentsLastActivity",
    "getActiveRuns",
    "getEnvironmentRuns",
    "getRunSnapshot",
    "getEnvironmentKpis",
    "getRecentFailedRuns",
  ],
  // notifications are deliberately absent: they're per-user rows with no
  // project column, written only to their recipient; a link into a project the
  // user has since lost resolves to the 404 page.
  "actions/milestones.ts": ["listMilestones"],
};

const SCOPE_HELPERS =
  /projectScope|projectIdsWhere|requireProjectPage|requireProjectPermission|getProjectRole/;

function body(source: string, name: string): string {
  const start = source.search(
    new RegExp(`export (async )?function ${name}\\b`)
  );
  if (start < 0) throw new Error(`${name} not found`);
  const next = source.slice(start + 1).search(/\nexport /);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

describe("cross-project reads are scoped", () => {
  for (const [file, fns] of Object.entries(SCOPED_READS)) {
    const source = readFileSync(file, "utf8");
    for (const fn of fns) {
      it(`${file} ${fn}`, () => {
        expect(body(source, fn)).toMatch(SCOPE_HELPERS);
      });
    }
  }
});

// Every project-scoped mutation must state the permission it needs.
const SCOPED_WRITES: Record<string, Record<string, RegExp>> = {
  "actions/issues.ts": {
    addComment: /issue: \["write"\]/,
    createIssue: /issue: \["write"\]/,
    updateIssue: /issue: \["write"\]/,
    // setIssueStatus delegates to updateIssue, which owns the guard.
    setIssueStatus: /return updateIssue\(/,
    bulkSetStatus: /requireProjectPermissionForAll\([\s\S]*issue: \["write"\]/,
    bulkDeleteIssues:
      /requireProjectPermissionForAll\([\s\S]*issue: \["delete"\]/,
    deleteIssue: /issue: \["delete"\]/,
  },
  "actions/issue-attachments.ts": {
    listIssueAttachments: /project: \["read"\]/,
    deleteIssueAttachment: /issue: \["write"\]/,
  },
  "actions/labels.ts": { setIssueLabels: /issue: \["write"\]/ },
  "actions/milestones.ts": {
    createMilestone: /issue: \["write"\]/,
    updateMilestone: /issue: \["write"\]/,
    setMilestoneClosed: /issue: \["write"\]/,
    deleteMilestone: /issue: \["delete"\]/,
  },
  "actions/test-runs.ts": {
    listIssueTestRuns: /project: \["read"\]/,
    recordTestRun: /issue: \["write"\]/,
  },
  "actions/services.ts": {
    getAllServiceStatuses: /project: \["read"\]/,
    controlService: /service: \["control"\]/,
  },
  "actions/backups.ts": {
    getBackupList: /database: \["backup"\]/,
    revalidateBackupList: /database: \["backup"\]/,
    createDatabaseBackup: /database: \["backup"\]/,
    restoreDatabaseBackup: /database: \["restore"\]/,
  },
  "actions/databases.ts": {
    getDatabaseList: /project: \["read"\]/,
    createDatabase: /database: \["create"\]/,
    dropDatabase: /database: \["drop"\]/,
    renameDatabase: /database: \["rename"\]/,
  },
  "actions/mailpit-settings.ts": {
    getMailpitSettings: /environment: \["update"\]/,
    saveMailpitSettings: /environment: \["update"\]/,
    testMailpitConnection: /environment: \["update"\]/,
  },
  "actions/environments.ts": {
    createEnvironment: /environment: \["create"\]/,
    updateEnvironment: /environment: \["update"\]/,
    deleteEnvironment: /environment: \["delete"\]/,
  },
  "actions/project-members.ts": {
    listProjectMembers: /member: \["manage"\]/,
    addProjectMember: /member: \["manage"\]/,
    updateProjectMemberRole: /member: \["manage"\]/,
    removeProjectMember: /member: \["manage"\]/,
  },
  "actions/jira.ts": {
    getJiraLink: /project: \["read"\]/,
    saveJiraLink: /environment: \["update"\]/,
    unlinkJiraProject: /environment: \["update"\]/,
    syncJiraProjectNow: /environment: \["update"\]/,
  },
};

describe("project-scoped writes state their permission", () => {
  for (const [file, fns] of Object.entries(SCOPED_WRITES)) {
    const source = readFileSync(file, "utf8");
    for (const [fn, pattern] of Object.entries(fns)) {
      it(`${file} ${fn}`, () => {
        expect(body(source, fn)).toMatch(pattern);
      });
    }
  }
});

describe("issue writes validate their references", () => {
  const source = readFileSync("actions/issues.ts", "utf8");
  for (const fn of ["createIssue", "updateIssue"]) {
    it(`${fn} checks assignee and same-project references`, () => {
      expect(body(source, fn)).toMatch(/canAssignTo/);
      expect(body(source, fn)).toMatch(/referencesInProject/);
    });
  }
  it("canAssignTo reuses the shared assignable-users predicate", () => {
    expect(source).toMatch(/assignableUsersWhere\(/);
    expect(source).not.toMatch(/"infra"/);
  });
});

// The old catch-all helpers live only in lib/auth-session until Task 8 removes
// them. UI files (layouts, components, toggle-only pages) are covered later.
describe("no legacy authorization helpers outside lib/auth-session", () => {
  const LEGACY =
    /\b(requireAdmin|isAdmin|requireCapability|getEffectiveRole|roleHasCapability)\(/;
  // Bun's glob can't nest a "/" inside braces, so scan the roots separately.
  const roots = ["actions", "lib", "app/api"];
  const files = roots.flatMap((root) => [
    ...Array.from(
      new Bun.Glob("**/*.{ts,tsx}").scanSync(root),
      (f) => `${root}/${f}`
    ),
  ]);
  for (const file of files) {
    // Both modules are deleted in Task 8; they define the helpers.
    if (file === "lib/auth-session.ts" || file === "lib/roles.ts") continue;
    it(file, () => {
      expect(readFileSync(file, "utf8")).not.toMatch(LEGACY);
    });
  }
});
