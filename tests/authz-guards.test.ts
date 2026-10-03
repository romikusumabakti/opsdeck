import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

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
    listMemberCandidates: /member: \["manage"\]/,
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

// A notification carries the issue's key and title, so recipients must be able
// to see the project. Every notifyIssueMention call site must draw its
// recipients from projectVisibleUsersWhere.
describe("mention notifications only reach users who can see the project", () => {
  const source = readFileSync("actions/issues.ts", "utf8");
  it("addComment selects mention candidates with projectVisibleUsersWhere", () => {
    const fn = body(source, "addComment");
    expect(fn).toMatch(
      /projectVisibleUsersWhere\(\s*eq\(projectMembers\.projectId, issue\.projectId\)/
    );
    expect(fn.indexOf("projectVisibleUsersWhere(")).toBeLessThan(
      fn.indexOf("notifyIssueMention(")
    );
  });
  it("notifyIssueMention is only called from addComment", () => {
    const files = Array.from(
      new Bun.Glob("**/*.{ts,tsx}").scanSync("actions"),
      (f) => `actions/${f}`
    );
    const callers = files.filter((f) =>
      /notifyIssueMention\(/.test(readFileSync(f, "utf8"))
    );
    expect(callers).toEqual(["actions/issues.ts"]);
    expect(source.match(/notifyIssueMention\(/g)?.length).toBe(1);
  });
  it("visible roles include observer; assignee roles do not", () => {
    const helpers = readFileSync("lib/assignees.ts", "utf8");
    expect(helpers).toMatch(
      /ORG_WIDE_VISIBLE_ROLES = \["admin", "infra", "observer"\]/
    );
    expect(helpers).toMatch(/ORG_WIDE_ASSIGNEE_ROLES = \["admin", "infra"\]/);
  });
});

// The old catch-all helpers have been removed. Everything under actions, lib, app
// and components is scanned to ensure no legacy helper calls remain.
describe("no legacy authorization helpers outside lib/auth-session", () => {
  const LEGACY =
    /\b(requireAdmin|isAdmin|requireCapability|getEffectiveRole|roleHasCapability|useCanRunOps)\(/;
  // Bun's glob can't nest a "/" inside braces, so scan the roots separately.
  const roots = ["actions", "lib", "app", "components"];
  const files = roots.flatMap((root) => [
    ...Array.from(
      new Bun.Glob("**/*.{ts,tsx}").scanSync(root),
      (f) => `${root}/${f}`
    ),
  ]);
  it("scans a plausible number of files", () => {
    expect(files.length).toBeGreaterThan(50);
  });
  it("scans at least one file in every root", () => {
    for (const root of roots) {
      expect(files.some((f) => f.startsWith(`${root}/`))).toBe(true);
    }
  });
  for (const file of files) {
    it(file, () => {
      expect(readFileSync(file, "utf8")).not.toMatch(LEGACY);
    });
  }
});

// Binding an environment to infrastructure is fleet-level power (service
// control, database drop/restore and logs run against whatever it points at),
// so it needs org server:manage, not just a project role.
describe("environment infrastructure bindings need server:manage", () => {
  const source = readFileSync("actions/environments.ts", "utf8");
  it("createEnvironment requires server:manage", () => {
    expect(body(source, "createEnvironment")).toMatch(
      /requireOrgPermission\(\{ server: \["manage"\] \}\)/
    );
  });
  it("updateEnvironment requires server:manage when an infra field changes", () => {
    const fn = body(source, "updateEnvironment");
    expect(fn).toMatch(
      /changedInfraFields\([\s\S]*requireOrgPermission\(\{ server: \["manage"\] \}\)/
    );
    // The check must run before the try block, so ForbiddenError propagates.
    expect(fn.indexOf("changedInfraFields(")).toBeLessThan(fn.indexOf("try {"));
  });
  it("the new-environment page requires server:manage", () => {
    expect(
      readFileSync(
        "app/[locale]/[projectKey]/environments/new/page.tsx",
        "utf8"
      )
    ).toMatch(/requireOrgPage\(\{ server: \["manage"\] \}\)/);
  });
  it("the settings page only fetches servers for server:manage", () => {
    const page = readFileSync(
      "app/[locale]/[projectKey]/[envSlug]/settings/page.tsx",
      "utf8"
    );
    expect(page).toMatch(/canManageServers \? getServers\(\)/);
  });
  it("listServerOptions is gone", () => {
    expect(readFileSync("actions/servers.ts", "utf8")).not.toMatch(
      /listServerOptions/
    );
  });
});

// Pages any project role can open must not call an action that throws for
// some of those roles while rendering; that would crash to the error boundary.
describe("render-time permissioned reads are gated", () => {
  it("the databases page lists backups only for database:backup", () => {
    const page = readFileSync(
      "app/[locale]/[projectKey]/[envSlug]/databases/page.tsx",
      "utf8"
    );
    expect(page).toMatch(/canProject\(role, \{ database: \["backup"\] \}\)/);
    expect(page).toMatch(/canBackup\s*\?\s*getBackupList\(/);
    expect(page.match(/getBackupList\(/g)?.length).toBe(1);
  });
});

// Observers can read servers, storage and tunnels but not manage them; the
// pages must hide controls that would only throw ForbiddenError.
const ORG_READ_PAGES: Record<string, RegExp[]> = {
  "app/[locale]/servers/page.tsx": [
    /server: \["manage"\]/,
    /server: \["terminal"\]/,
    /server: \["files"\]/,
  ],
  "app/[locale]/servers/[id]/page.tsx": [
    /server: \["manage"\]/,
    /readOnly=\{!canManage\}/,
  ],
  "app/[locale]/storage/page.tsx": [
    /storage: \["manage"\]/,
    /storage: \["files"\]/,
  ],
  "app/[locale]/storage/[id]/page.tsx": [
    /storage: \["manage"\]/,
    /storage: \["files"\]/,
    /readOnly=\{!canManage\}/,
  ],
  "app/[locale]/admin/tunnels/page.tsx": [/tunnel: \["manage"\]/],
  "app/[locale]/admin/tunnels/[id]/page.tsx": [/tunnel: \["manage"\]/],
  "app/[locale]/admin/tunnels/zones/page.tsx": [/tunnel: \["manage"\]/],
};

describe("org read pages gate their management controls", () => {
  for (const [file, patterns] of Object.entries(ORG_READ_PAGES)) {
    it(file, () => {
      const source = readFileSync(file, "utf8");
      expect(source).toMatch(/canOrg\(/);
      for (const pattern of patterns) expect(source).toMatch(pattern);
    });
  }
});

describe("access_control migration refuses a second run", () => {
  const sql = readFileSync(
    "drizzle/20261003000000_access_control/migration.sql",
    "utf8"
  );
  it("raises before any UPDATE when project_role already has contributor", () => {
    const guard = sql.search(
      /enumlabel = 'contributor'[\s\S]*RAISE EXCEPTION 'access_control migration already applied'/
    );
    expect(guard).toBeGreaterThan(sql.indexOf("BEGIN;"));
    expect(guard).toBeLessThan(sql.indexOf("UPDATE "));
  });
});

describe("old role module is gone", () => {
  it("lib/roles.ts no longer exists", () => {
    expect(existsSync("lib/roles.ts")).toBe(false);
  });
  it("nothing imports @/lib/roles", () => {
    const files = Array.from(
      new Bun.Glob("{actions,app,lib,components,tests}/**/*.{ts,tsx}").scanSync(".")
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      if (file === "tests/authz-guards.test.ts") continue;
      expect(readFileSync(file, "utf8")).not.toContain('@/lib/roles"');
    }
  });
});
