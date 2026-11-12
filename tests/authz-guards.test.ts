import { existsSync, globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The pages: TanStack file routes, where each page's guard and gating live.
const APP = "web/routes/$locale/_app";

// Cross-project reads must filter to the caller's projects. The DB lookups are
// thin, so the cheapest durable check is structural: each listed function must
// mention one of the scope helpers. Add a function here when you add a
// cross-project read.
const SCOPED_READS: Record<string, string[]> = {
  "server/services/project-catalog.ts": [
    "listProjects",
    "listProjectsWithEnvironments",
    "getProject",
    "getProjectWithEnvironments",
    "getProjectByKeyWithEnvironments",
  ],
  "server/services/environments.ts": [
    "listEnvironments",
    "getEnvironmentsLastOpened",
    "getEnvironmentById",
  ],
  "server/services/issues.ts": [
    "getOpenIssueCounts",
    "getAssignedIssueCounts",
    "getIssueDetail",
    "listAllIssues",
    "listIssues",
  ],
  "server/services/runs.ts": [
    "getEnvironmentsLastActivity",
    "getActiveRuns",
    "getEnvironmentRuns",
    "getRunSnapshot",
    "getEnvironmentKpis",
  ],
  // notifications are deliberately absent: they're per-user rows with no
  // project column, written only to their recipient; a link into a project the
  // user has since lost resolves to the 404 page.
  "lib/people/queries.ts": [
    "listPeople",
    "getPersonProjects",
    "listPersonOpenIssues",
    "listPersonRecentRuns",
  ],
  "lib/home/queries.ts": [
    "getAttentionGroups",
    "listMyOpenIssues",
    "listRecentEnvironments",
    "listIssueProjects",
    "getHomeAccess",
  ],
};

const SCOPE_HELPERS =
  /projectScope|projectIdsWhere|requireProjectPage|requireProjectPermission|getProjectRole|getProjectAccess/;

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
  "server/services/home.ts": {
    acknowledgeAttentionGroup: /run: \["acknowledge"\]/,
    unacknowledgeRuns: /run: \["acknowledge"\]/,
  },
  "server/services/issues.ts": {
    addComment: /issue: \["write"\]/,
    createIssue: /issue: \["write"\]/,
    updateIssue: /issue: \["write"\]/,
    // setIssueStatus delegates to updateIssue, which owns the guard.
    setIssueStatus: /return updateIssue\(/,
    bulkSetStatus: /requireProjectPermissionForAll\([\s\S]*issue: \["write"\]/,
    bulkDeleteIssues:
      /requireProjectPermissionForAll\([\s\S]*issue: \["delete"\]/,
    deleteIssue: /issue: \["delete"\]/,
    getIssueFormOptions: /issue: \["write"\]/,
  },
  "server/services/issue-attachments.ts": {
    listIssueAttachments: /project: \["read"\]/,
    deleteIssueAttachment: /issue: \["write"\]/,
  },
  "server/services/labels.ts": { setIssueLabels: /issue: \["write"\]/ },
  "server/services/test-runs.ts": {
    listIssueTestRuns: /project: \["read"\]/,
    recordTestRun: /issue: \["write"\]/,
  },
  "server/services/services.ts": {
    getAllServiceStatuses: /project: \["read"\]/,
    controlService: /service: \["control"\]/,
  },
  "server/services/deploys.ts": {
    listDeployTargets: /deploy: \["view"\]/,
    createDeployTarget: /deploy: \["configure"\]/,
    updateDeployTarget: /deploy: \["configure"\]/,
    deleteDeployTarget: /deploy: \["configure"\]/,
    deployTag: /deploy: \["run"\]/,
    rollbackTarget: /deploy: \["rollback"\]/,
  },
  "server/services/backups.ts": {
    getBackupList:
      /requireAnyProjectPermission\([^)]*database: \["backup"\][^)]*database: \["restore"\]/s,
    createDatabaseBackup: /database: \["backup"\]/,
    restoreDatabaseBackup: /database: \["restore"\]/,
  },
  "server/services/databases.ts": {
    getDatabaseList: /project: \["read"\]/,
    createDatabase: /database: \["create"\]/,
    dropDatabase: /database: \["drop"\]/,
    renameDatabase: /database: \["rename"\]/,
  },
  "server/services/mailpit-settings.ts": {
    getMailpitSettings: /environment: \["update"\]/,
    saveMailpitSettings: /environment: \["update"\]/,
    testMailpitConnection: /environment: \["update"\]/,
  },
  "server/services/environments.ts": {
    // The placement policy of the bound servers decides (canPlaceEnvironment),
    // checked by validateNewEnvironment (below).
    createEnvironment: /validateNewEnvironment\(/,
    updateEnvironment: /environment: \["update"\]/,
    deleteEnvironment: /environment: \["delete"\][\s\S]*server: \["manage"\]/,
  },
  "server/services/environment-teardown.ts": {
    startTeardown: /environment: \["delete"\]/,
    retryTeardown: /environment: \["delete"\]/,
    cancelTeardown: /environment: \["delete"\]/,
    getTeardown: /project: \["read"\]/,
  },
  "server/services/project-members.ts": {
    listProjectMembers: /member: \["manage"\]/,
    listMemberCandidates: /member: \["manage"\]/,
    addProjectMember: /member: \["manage"\]/,
    updateProjectMemberRole: /member: \["manage"\]/,
    removeProjectMember: /member: \["manage"\]/,
  },
  "server/services/environment-setup.ts": {
    // authorize() asks SETUP_PERMISSIONS (below) of the target project.
    previewEnvironmentSetup: /checkSetup\(input, "collect"\)/,
    createEnvironmentSetup: /checkSetup\(input, "throw"\)/,
    getCopySource: /project: \["read"\]/,
  },
  "server/services/variables.ts": {
    listVariables: /variable: \["read"\]/,
    putVariable: /variable: \["write"\]/,
    deleteVariable: /variable: \["write"\]/,
    regenerateVariable: /variable: \["write"\]/,
    applyTemplate: /variable: \["write"\]/,
    setEnvFileManaged: /variable: \["write"\], deploy: \["configure"\]/,
  },
  "server/services/jira.ts": {
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
  const source = readFileSync("server/services/issues.ts", "utf8");
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

describe("environment writes validate their owner", () => {
  const source = readFileSync("server/services/environments.ts", "utf8");
  for (const fn of ["validateNewEnvironment", "updateEnvironment"]) {
    it(`${fn} checks owner eligibility`, () => {
      expect(body(source, fn)).toMatch(/ownerIdToVerify\(/);
      expect(body(source, fn)).toMatch(/requireEligibleOwner\(/);
    });
  }
  it("the owner check reuses the shared assignable-users predicate", () => {
    expect(source).toMatch(/assignableUsersWhere\(/);
  });
});

// A notification carries the issue's key and title, so recipients must be able
// to see the project. Every notifyIssueMention call site must draw its
// recipients from projectVisibleUsersWhere.
describe("mention notifications only reach users who can see the project", () => {
  const source = readFileSync("server/services/issues.ts", "utf8");
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
      globSync("**/*.{ts,tsx}", { cwd: "server/services" }),
      (f) => `server/services/${f}`
    );
    const callers = files.filter((f) =>
      /notifyIssueMention\(/.test(readFileSync(f, "utf8"))
    );
    expect(callers).toEqual(["server/services/issues.ts"]);
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

describe("lookups by client-supplied id check the caller first", () => {
  it("recordEnvironmentAccess only records visible environments", () => {
    const fn = body(
      readFileSync("server/services/environments.ts", "utf8"),
      "recordEnvironmentAccess"
    );
    expect(fn).toMatch(/getProjectRole\(\{ environmentId \}\)/);
    expect(fn.indexOf("getProjectRole(")).toBeLessThan(fn.indexOf(".insert("));
  });
  it("getRunSnapshot rejects a non-uuid run id before querying", () => {
    const fn = body(
      readFileSync("server/services/runs.ts", "utf8"),
      "getRunSnapshot"
    );
    expect(fn).toMatch(/uuidSchema\.safeParse\(runId\)/);
    expect(fn.indexOf("uuidSchema.safeParse(runId)")).toBeLessThan(
      fn.indexOf("findFirst(")
    );
  });
  it("deleteIssueAttachment requires a session before its lookup", () => {
    const fn = body(
      readFileSync("server/services/issue-attachments.ts", "utf8"),
      "deleteIssueAttachment"
    );
    expect(fn.indexOf("requireSession()")).toBeGreaterThan(-1);
    expect(fn.indexOf("requireSession()")).toBeLessThan(
      fn.indexOf("findFirst(")
    );
  });
});

// Org-level access changes leave an audit trail (entityType "access"), and the
// activity page renders each action.
const ACCESS_AUDIT: Record<string, string> = {
  deleteUser: "user.deleted",
  bulkDeleteUsers: "user.deleted",
  revokeInvitation: "user.invitationRevoked",
  bulkRevokeInvitations: "user.invitationRevoked",
  resendInvitation: "user.invitationResent",
};

describe("access changes are recorded in the activity log", () => {
  const source = readFileSync("server/services/users.ts", "utf8");
  const page = readFileSync(`${APP}/admin.activity.tsx`, "utf8");
  for (const [fn, action] of Object.entries(ACCESS_AUDIT)) {
    it(`${fn} records ${action}`, () => {
      const code = body(source, fn);
      expect(code).toContain(`action: "${action}"`);
      expect(code).toContain('entityType: "access"');
      expect(page).toContain(`case "${action}":`);
    });
  }
});

// Revealing secret values leaves a trail the activity page can render.
describe("revealing variables is recorded in the activity log", () => {
  it("listVariables records variables.revealed and the page renders it", () => {
    const code = body(
      readFileSync("server/services/variables.ts", "utf8"),
      "listVariables"
    );
    expect(code).toMatch(/if \(reveal\) \{\s*await recordActivity\(/);
    expect(code).toContain('action: "variables.revealed"');
    expect(readFileSync(`${APP}/admin.activity.tsx`, "utf8")).toContain(
      'case "variables.revealed":'
    );
  });
});

// The old catch-all helpers have been removed. Everything under server, lib,
// components and web is scanned to ensure no legacy helper calls remain.
describe("no legacy authorization helpers outside lib/auth-session", () => {
  const LEGACY =
    /\b(requireAdmin|isAdmin|requireCapability|getEffectiveRole|roleHasCapability|useCanRunOps)\(/;
  // Bun's glob can't nest a "/" inside braces, so scan the roots separately.
  const roots = [
    "server/services",
    "server/routes",
    "lib",
    "components",
    "web",
  ];
  const files = roots.flatMap((root) => [
    ...Array.from(
      globSync("**/*.{ts,tsx}", { cwd: root }),
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
// The setup wizard creates environments, targets, variables and domains in
// one request: it must ask the target project for every right the single-row
// APIs ask for, and run their checks rather than its own.
describe("environment setup reuses the existing rules", () => {
  const source = readFileSync("server/services/environment-setup.ts", "utf8");
  it("asks environment:create, deploy configure/run and variable:write", () => {
    expect(readFileSync("lib/permissions.ts", "utf8")).toMatch(
      /SETUP_PERMISSIONS = \{\s*environment: \["create"\],\s*deploy: \["configure", "run"\],\s*variable: \["write"\],\s*\}/
    );
    expect(source).toMatch(/SETUP_PERMISSIONS,\n\} from "@\/lib\/permissions"/);
    expect(source).toMatch(
      /requireProjectPermission\(\s*\{ projectId: input\.projectId \},\s*SETUP_PERMISSIONS\s*\)/
    );
  });
  it("runs the environment, variable and domain checks of the other APIs", () => {
    for (const check of [
      "validateNewEnvironment(",
      "planEnvironmentVariables(",
      "validateDomainBinding(",
      "deployDirInUse(",
    ]) {
      expect(source).toContain(check);
    }
  });
});

describe("environment infrastructure bindings need server:manage", () => {
  const source = readFileSync("server/services/environments.ts", "utf8");
  // Restricted servers keep the server:manage rule; open ones admit project
  // maintainers (tests/placement.test.ts). The check must run before the try
  // block, so ForbiddenError propagates.
  it("createEnvironment checks the placement of every bound server", () => {
    const check = body(source, "validateNewEnvironment");
    expect(check).toMatch(
      /createdBindings\([\s\S]*requireEnvironmentPlacement\(/
    );
    expect(check).toMatch(/requireNoSharedDbOverlap\(/);
    const fn = body(source, "createEnvironment");
    expect(fn.indexOf("validateNewEnvironment(")).toBeGreaterThan(-1);
    expect(fn.indexOf("validateNewEnvironment(")).toBeLessThan(
      fn.indexOf("try {")
    );
    expect(source).toMatch(/canPlaceEnvironment\(/);
  });
  it("updateEnvironment checks placement on a project move or binding change", () => {
    const fn = body(source, "updateEnvironment");
    expect(fn).toMatch(
      /targetProjectId !== stored\.projectId[\s\S]*requireEnvironmentPlacement\([\s\S]*changesBindings\([\s\S]*requireEnvironmentPlacement\(/
    );
    expect(fn.lastIndexOf("requireEnvironmentPlacement(")).toBeLessThan(
      fn.indexOf("try {")
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
  // The New environment page places through the setup service, whose
  // placement rules admit engineers on open and default servers only.
  it("the new-environment page asks the setup's project permissions", () => {
    const page = readFileSync(
      `${APP}/$projectKey.environments.new.tsx`,
      "utf8"
    );
    expect(page).toMatch(
      /requireProjectRole\(queryClient, project\.id, SETUP_PERMISSIONS\)/
    );
    expect(page).not.toMatch(/@\/components\/environment-form/);
  });
  it("the settings page only fetches servers for server:manage", () => {
    const page = readFileSync(
      `${APP}/$projectKey.$envSlug.settings.tsx`,
      "utf8"
    );
    expect(page).toMatch(
      /canOrg\(me\?\.orgRole, \{ server: \["manage"\] \}\)\s*\?\s*loaderQuery\(queryClient, getServersQuery\(\)\)/
    );
    expect(page).toMatch(/enabled: canManageServers/);
  });
  it("listServerOptions is gone", () => {
    expect(readFileSync("server/services/servers.ts", "utf8")).not.toMatch(
      /listServerOptions/
    );
  });
});

// Pages any project role can open must not call an action that throws for
// some of those roles while rendering; that would crash to the error boundary.
describe("render-time permissioned reads are gated", () => {
  it("the databases page lists backups for database:backup or database:restore", () => {
    const page = readFileSync(
      `${APP}/$projectKey.$envSlug.databases.tsx`,
      "utf8"
    );
    expect(page).toMatch(
      /canAnyProject\(role, \[\s*\{ database: \["backup"\] \},\s*\{ database: \["restore"\] \},?\s*\]\)\s*\)\s*\{\s*void queryClient\.prefetchQuery\(getBackupListQuery\(/
    );
    expect(page).toMatch(/canListBackups \? getBackupListQuery\(/);
    expect(page.match(/getBackupListQuery\(/g)?.length).toBe(2);
  });
});

// Observers can read servers, storage and tunnels but not manage them; the
// pages must hide controls that would only throw ForbiddenError.
const ORG_READ_PAGES: Record<string, RegExp[]> = {
  [`${APP}/servers.index.tsx`]: [
    /server: \["manage"\]/,
    /server: \["terminal"\]/,
    /server: \["files"\]/,
  ],
  [`${APP}/servers.$id.index.tsx`]: [
    /server: \["manage"\]/,
    /readOnly=\{!canManage\}/,
  ],
  [`${APP}/storage.index.tsx`]: [
    /storage: \["manage"\]/,
    /storage: \["files"\]/,
  ],
  [`${APP}/storage.$id.index.tsx`]: [
    /storage: \["manage"\]/,
    /storage: \["files"\]/,
    /readOnly=\{!canManage\}/,
  ],
  // Zones and local tunnels are sections of the Cloudflare page.
  [`${APP}/admin.cloudflare.index.tsx`]: [/tunnel: \["manage"\]/],
  [`${APP}/admin.cloudflare.local-tunnels.$id.index.tsx`]: [
    /tunnel: \["manage"\]/,
  ],
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

describe("old role module is gone", () => {
  it("lib/roles.ts no longer exists", () => {
    expect(existsSync("lib/roles.ts")).toBe(false);
  });
  it("nothing imports @/lib/roles", () => {
    const files = Array.from(
      globSync("{server,lib,components,web,tests}/**/*.{ts,tsx}", {
        cwd: ".",
      })
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      if (file === "tests/authz-guards.test.ts") continue;
      expect(readFileSync(file, "utf8")).not.toContain('@/lib/roles"');
    }
  });
});

describe("home acknowledgement actions", () => {
  const source = readFileSync("server/services/home.ts", "utf8");
  for (const fn of ["acknowledgeAttentionGroup", "unacknowledgeRuns"]) {
    it(`${fn} validates input before the permission lookup`, () => {
      const b = body(source, fn);
      expect(b.indexOf("safeParse")).toBeGreaterThan(-1);
      expect(b.indexOf("safeParse")).toBeLessThan(
        b.indexOf("requireProjectPermission(")
      );
    });
  }
  it("undo only clears acknowledgements the caller made", () => {
    expect(body(source, "unacknowledgeRuns")).toMatch(
      /eq\(runs\.acknowledgedById, session\.user\.id\)/
    );
  });
});

// Home's attention groups key on runs.kind; a run created without one falls
// back to its per-run description and never groups or auto-resolves.
describe("ops runs record their kind", () => {
  // Each call's argument object runs to the first "});" after it.
  function runInserts(source: string): string[] {
    const calls: string[] = [];
    const re = /createRun(?:OrRefuse)?\(\{|\.insert\(runs\)\.values\(\{/g;
    for (const m of source.matchAll(re)) {
      const end = source.indexOf("});", m.index);
      calls.push(source.slice(m.index, end));
    }
    return calls;
  }
  for (const file of [
    "server/services/backups.ts",
    "server/services/mock-time.ts",
  ]) {
    it(`${file} sets kind on every run it creates`, () => {
      const calls = runInserts(readFileSync(file, "utf8"));
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call).toMatch(/\bkind: "/);
    });
  }
  it("covers every run-creation site in both files", () => {
    const count = (file: string) =>
      runInserts(readFileSync(file, "utf8")).length;
    expect(count("server/services/backups.ts")).toBe(2);
    expect(count("server/services/mock-time.ts")).toBe(4);
  });
});

// Assignment does not imply issue:write: a viewer assigned an issue must see a
// read-only status, not a StatusSelect whose change would be refused.
describe("Home my-issues gates status changes on issue:write", () => {
  it("listMyOpenIssues computes canWrite from issue:write", () => {
    const fn = body(
      readFileSync("lib/home/queries.ts", "utf8"),
      "listMyOpenIssues"
    );
    expect(fn).toMatch(/canWrite: canProject\([\s\S]*issue: \["write"\]/);
  });
  it("the list renders StatusSelect only when canWrite", () => {
    const list = readFileSync(
      "web/routes/$locale/_app/-components/home/my-issues-list.tsx",
      "utf8"
    );
    expect(list).toMatch(/i\.canWrite \? \(\s*<StatusSelect/);
    expect(list.match(/<StatusSelect/g)?.length).toBe(1);
  });
});

// /admin/access was merged into /admin/users (Project access tab). The old
// route only redirects; the users page owns the guard and gates the matrix.
describe("users and access live on one guarded page", () => {
  const page = readFileSync(`${APP}/admin.users.tsx`, "utf8");
  it("the users page requires user:list", () => {
    expect(page).toMatch(
      /requireOrgRole\(queryClient, \{ user: \["list"\] \}\)/
    );
  });
  it("the users page fetches the access matrix only for audit:read", () => {
    expect(page).toMatch(
      /canOrg\(role, \{ audit: \["read"\] \}\)\s*\?\s*loaderQuery\(queryClient, getAccessMatrixQuery\(\)\)/
    );
    expect(page).toMatch(/enabled: canViewAccess/);
  });
  it("the users page fetches invitations only for user:invite", () => {
    expect(page).toMatch(
      /canOrg\(role, \{ user: \["invite"\] \}\)\s*\?\s*loaderQuery\(queryClient, listPendingInvitationsQuery\(\)\)/
    );
    expect(page).toMatch(/enabled: canInvite/);
  });
  it("the old access page only redirects to the users page", () => {
    const old = readFileSync(`${APP}/admin.access.tsx`, "utf8");
    expect(old).not.toMatch(/requireOrgRole|getAccessMatrix/);
    expect(old).toMatch(/redirect\("\/admin\/users\?tab=access", locale\)/);
  });
  it("the admin landing picks users for user:list, else activity", () => {
    const landing = readFileSync(`${APP}/admin.index.tsx`, "utf8");
    expect(landing).toMatch(/canOrg\([^)]*\{ user: \["list"\] \}\)/);
    expect(landing).toMatch(/"\/admin\/users"/);
    expect(landing).toMatch(/"\/admin\/activity"/);
    expect(landing).not.toMatch(/\/admin\/access/);
  });
  it("nothing links to /admin/access any more", () => {
    // A quoted route, so the better-auth "plugins/admin/access" import and
    // prose comments don't count.
    const LINK = /["'`]\/admin\/access\b/;
    const roots = [
      "server/services",
      "server/routes",
      "lib",
      "components",
      "web",
    ];
    const offenders = roots.flatMap((root) =>
      Array.from(
        globSync("**/*.{ts,tsx}", { cwd: root }),
        (f) => `${root}/${f}`
      ).filter((f) => LINK.test(readFileSync(f, "utf8")))
    );
    expect(offenders).toEqual([]);
  });
  it("access and user reads state their guard first", () => {
    const access = readFileSync("server/services/access.ts", "utf8");
    const users = readFileSync("server/services/users.ts", "utf8");
    const first = (code: string, guard: RegExp) => {
      const at = code.search(guard);
      expect(at).toBeGreaterThan(-1);
      const query = code.search(/\bdb\s*\./);
      expect(query).toBeGreaterThan(-1);
      expect(at).toBeLessThan(query);
    };
    first(
      body(access, "getAccessMatrix"),
      /requireOrgPermission\(\{ audit: \["read"\] \}\)/
    );
    first(
      body(access, "offboardUser"),
      /requireOrgPermission\(\{ user: \["offboard"\] \}\)/
    );
    first(
      body(users, "listUsers"),
      /requireOrgPermission\(\{ user: \["list"\] \}\)/
    );
  });
});

// Routers decide "signed in or not" once, through the two factories in
// server/router.ts; finer permissions come from the service they call, or from
// the route itself when it reads lib/ directly (page data).
describe("API routers reach a guard", () => {
  const files = Array.from(
    globSync("*.ts", { cwd: "server/routes" }),
    (f) => `server/routes/${f}`
  );
  // Everything reachable without a session. Adding a route here is a security
  // decision: it must be safe for an anonymous caller.
  const PUBLIC: Record<string, string[]> = {
    "server/routes/session.ts": ["GET /bootstrap", "GET /me"],
    "server/routes/users.ts": [
      "GET /has-any-user",
      "POST /create-initial-user",
      "GET /get-invitation-by-token",
      "POST /accept-invitation",
    ],
    // Jira calls the webhook with no session; the unguessable path token is
    // its credential, and the payload only names an issue to re-fetch.
    "server/routes/jira.ts": ["POST /:token"],
    // CI posts build notifications with no session; a per-app HMAC of the raw
    // body is the credential.
    "server/routes/deploy-hooks.ts": ["POST /builds"],
    // The favicon, linked by the signed-out sign-in, 404 and error pages.
    "server/routes/brand.ts": ["GET /icon.svg"],
  };
  // A router's routes: from its factory call up to the next exported router.
  function routesOf(source: string, factory: string): string[] {
    return source
      .split(/\nexport const /)
      .filter((chunk) => chunk.includes(`= ${factory}()`))
      .flatMap((chunk) =>
        Array.from(
          chunk.matchAll(/\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g),
          (m) => `${m[1]?.toUpperCase()} ${m[2]}`
        )
      );
  }

  it("scans the route files", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    it(`${file} builds its routers from the factories`, () => {
      expect(source).not.toMatch(/new Hono\b/);
      expect(source).toMatch(/\b(sessionRouter|publicRouter)\(\)/);
    });
    it(`${file} exposes only the pinned public routes`, () => {
      expect(routesOf(source, "publicRouter")).toEqual(PUBLIC[file] ?? []);
    });
    it(`${file} is mounted in server/app.ts`, () => {
      const name = file.slice("server/routes/".length, -".ts".length);
      expect(readFileSync("server/app.ts", "utf8")).toContain(
        `from "@/server/routes/${name}"`
      );
    });
  }

  it("knowledge page data applies the page's guard before loading", () => {
    const source = readFileSync("server/routes/knowledge.ts", "utf8");
    const handlers = source.split(/\n {2}\.(?:get|post)\(/).slice(1);
    const loading = handlers.filter((h) => /\bload\w+\(/.test(h));
    expect(loading.length).toBe(4);
    for (const h of loading) {
      const guard = h.search(
        /requireOrgPermission\(\{ knowledge: \["(read|write)"\] \}\)/
      );
      expect(guard).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(h.search(/\bload\w+\(/));
    }
    const revisions = handlers.find((h) =>
      h.startsWith('"/documents/:slug/revisions"')
    );
    expect(revisions).toMatch(/knowledge: \["write"\]/);
  });

  // The environment pages resolved their URL and applied a project guard
  // before rendering; the endpoints that replace those reads must too.
  it("environment page data applies the page's guard", () => {
    const resolve = readFileSync("server/routes/environments.ts", "utf8");
    const handler = resolve.slice(resolve.indexOf('"/resolve"'));
    expect(handler).toMatch(
      /resolveEnvIdByKeySlug\([\s\S]*requireProjectPage\(\{ environmentId \}\)/
    );
    const mail = readFileSync("server/routes/mail.ts", "utf8");
    const configured = mail.slice(mail.indexOf('"/configured"'));
    const guard = configured.search(
      /requireProjectPage\(\{ environmentId \}, \{ mail: \["read"\] \}\)/
    );
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(configured.indexOf("loadMailpitConfig("));
  });

  // Server rows carry the encrypted SSH password and host key blobs; the API
  // returns serverView's projection (tests/servers-ssh-api checks its fields).
  it("server reads strip the password", () => {
    const source = readFileSync("server/routes/servers.ts", "utf8");
    for (const route of [
      "/get-servers",
      "/get-server-by-id",
      "/create-server",
    ]) {
      const handler = source
        .slice(source.indexOf(`"${route}"`))
        .split(/\n {2}\./)[0];
      expect(handler).toMatch(/\bserverView\b/);
    }
  });
});

// The deploy job runs as the system, outside any request: it reads managed
// variables through lib/variables, never through a request-scoped service.
describe("the deploy job does not import server services", () => {
  it("lib/jobs/deploy.ts imports nothing from @/server/services", () => {
    expect(readFileSync("lib/jobs/deploy.ts", "utf8")).not.toMatch(
      /from "@\/server\/services\//
    );
  });
});
