# Project-level Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every page sits at one level (project or environment), and the sidebar and header show that level. The sidebar gets a project group, the overview tabs become pages, the Issues list moves to `/KEY/issues`, and project pages lose the "Select environment" placeholder.

**Architecture:**
- The project-group rules live in `lib/nav-path.ts` as pure functions, so they can be tested without React:
  - which items show, for which role, at which href;
  - where the project switcher goes;
  - what the URL means.
- The sidebar and the header breadcrumb render from those functions.
- New TanStack file routes host the former overview tabs. Old URLs redirect, following the `backup-database.tsx` pattern.

**Tech Stack:** Bun, React 19, TanStack Router (file routes, `beforeLoad` + `notFound()` / `redirect` from `@/i18n/navigation`), TanStack Query, use-intl, Vitest (happy-dom), Biome.

**Spec:** `docs/superpowers/specs/2026-11-11-project-level-navigation-design.md`

## Global Constraints

- **No server or schema change, no migration.** This is UI and routing only.
- **Permissions:**
  - Members: `{ member: ["manage"] }`.
  - Settings: `SECTION_PERMS.settings` (`{ environment: ["update"] }`).
  - Releases: `{ deploy: ["view"] }` and the project must be releasable.
  - Overview, Issues and Milestones: any project role.
  - Every guarded route uses `requireProjectRole` (`web/project-guard.ts`), after the scoped project lookup that 404s an invisible project.
- **i18n:** every new key goes into all five catalogs (`messages/{en,id,es,zh,ar}.json`). Real translations, as the `releases` keys were done.
- **Tests:** run with `bun --bun vitest run --maxWorkers=2 <files>`. `tsc` runs separately: `NODE_OPTIONS=--max-old-space-size=4096 bunx tsc --noEmit`. Never run both at once.
- **Before every commit:** `bunx biome ci .` must pass. Stop on failure.
- **Language:** all code, comments, test names and commit messages in English.
- **Work location:** a git worktree off `main` (e.g. `../opsdeck-wt-project-nav`, branch `feat/project-level-navigation`). Never on the shared checkout.

## Review Focus

1. **A project with no environments.** The project group must still render on `/KEY`, with Releases hidden. Pinned in Task 1 (`isProjectReleasable` with no environments → false) and Task 3.
2. **Old bookmarks** `/KEY/<env>/issues?status=all` and `/KEY?tab=members`. They must land on the new page with the search params kept. Pinned in Task 2's redirect tests.
3. **A QA member opening `/KEY/members` or `/KEY/settings` directly.** This must be refused by the guard, not show an empty page. Pinned in Task 2's source tests.
4. **Active state on `/KEY/issues/42`.** Issues is active and Overview is not. Pinned in Task 3.
5. **Switching project from `/CRMB/releases` to a container-only project.** It must land on the overview, not a 404. Pinned in Task 1.

---

### Task 1: Navigation rules in `lib/nav-path.ts`

**Files:**
- Modify: `lib/nav-path.ts`
- Test: `tests/nav-path.test.ts`

**Interfaces:**
- **Produces:**
  - `type ProjectPage = "overview" | "issues" | "issue" | "milestones" | "releases" | "members" | "settings" | "new-environment" | "other"`
  - `NavPath` project scope gains `issueNumber: string | null`. It is set only for `page: "issue"`.
  - `type ProjectNavKey = "overview" | "issues" | "milestones" | "releases" | "members" | "settings"`
  - `projectNavItems(projectKey: string, role: ProjectRole | null, releasable: boolean): { key: ProjectNavKey; href: string }[]`. Items come in the order above and are filtered by the Global Constraints permissions. `role === null` returns `[]`.
  - `isProjectReleasable(environments: readonly { projectId: string; projectReleasable: boolean }[], projectId: string): boolean`
  - `projectSwitchHref({ ..., releasable?: boolean })`. The new optional field (default `false`) describes the **target** project.
  - `PARALLEL_SECTIONS` loses `"issues"`.

- [ ] **Step 1: Write failing tests** in `tests/nav-path.test.ts`:

```ts
describe("parseNavPath project pages", () => {
  it.each([
    ["/CRMB/issues", "issues"],
    ["/CRMB/milestones", "milestones"],
    ["/CRMB/members", "members"],
    ["/CRMB/releases", "releases"],
    ["/CRMB/settings", "settings"],
  ])("%s is the %s page", (path, page) => {
    expect(parseNavPath(path)).toEqual({
      scope: "project", projectKey: "CRMB", page, issueNumber: null,
    });
  });
  it("reads an issue detail with its number", () => {
    expect(parseNavPath("/CRMB/issues/42")).toEqual({
      scope: "project", projectKey: "CRMB", page: "issue", issueNumber: "42",
    });
  });
});

describe("projectNavItems", () => {
  it("gives an engineer every page of a releasable project, in order", () => {
    expect(projectNavItems("CRMB", "engineer", true)).toEqual([
      { key: "overview", href: "/CRMB" },
      { key: "issues", href: "/CRMB/issues" },
      { key: "milestones", href: "/CRMB/milestones" },
      { key: "releases", href: "/CRMB/releases" },
      { key: "members", href: "/CRMB/members" },
      { key: "settings", href: "/CRMB/settings" },
    ]);
  });
  it("drops Releases for a container-only project", () => {
    expect(projectNavItems("SCMB", "engineer", false).map((i) => i.key))
      .not.toContain("releases");
  });
  it("gives QA only what its role allows", () => {
    // Derive the expected list from canProject so the test follows the role
    // matrix instead of hard-coding it.
    const keys = projectNavItems("CRMB", "qa", true).map((i) => i.key);
    expect(keys.slice(0, 3)).toEqual(["overview", "issues", "milestones"]);
    expect(keys.includes("members")).toBe(canProject("qa", { member: ["manage"] }));
    expect(keys.includes("settings")).toBe(canProject("qa", { environment: ["update"] }));
    expect(keys.includes("releases")).toBe(canProject("qa", { deploy: ["view"] }));
  });
  it("is empty without a role", () => {
    expect(projectNavItems("CRMB", null, true)).toEqual([]);
  });
});

describe("isProjectReleasable", () => {
  it("is true when any environment of the project says so", () => { /* p1 envs [false, true] → true */ });
  it("is false for a project without environments", () => {
    expect(isProjectReleasable([], "p1")).toBe(false);
  });
});

describe("projectSwitchHref from project pages", () => {
  // from = parseNavPath(<path>), target project SCMB, role engineer
  it.each([
    ["/CRMB/issues", true, "/SCMB/issues"],
    ["/CRMB/issues/42", true, "/SCMB/issues"],
    ["/CRMB/milestones", true, "/SCMB/milestones"],
    ["/CRMB/members", true, "/SCMB/members"],
    ["/CRMB/releases", true, "/SCMB/releases"],
    ["/CRMB/releases", false, "/SCMB"],
  ])("from %s (target releasable %s) goes to %s", (path, releasable, href) => { /* ... */ });
});
```

  Also update the existing tests that break by design:
  - the `parseNavPath` expectations gain `issueNumber: null`;
  - in `environmentSwitchHref`, `issues` is no longer parallel.

- [ ] **Step 2: Run the tests and confirm they fail**

  Run: `bun --bun vitest run --maxWorkers=2 tests/nav-path.test.ts`. Expected: FAIL (`projectNavItems` is not exported).

- [ ] **Step 3: Implement the change in `lib/nav-path.ts`**
  - `PROJECT_PAGES` maps `issues` → `"issues"` with no third segment, and to `"issue"` (with `issueNumber` = the third segment) when there is one. It also maps `milestones` and `members`.
  - `projectSwitchHref` from project scope: when the current project is the target, keep today's behaviour (go to the overview). Otherwise go to the target's item whose key equals the page (`issue` counts as `issues`), using `projectNavItems(target, role, releasable)`. If there is no such item, go to the overview. The existing settings test keeps passing through this rule.

- [ ] **Step 4: Run the tests and confirm they pass** (same command as Step 2). Expected: PASS.

- [ ] **Step 5: Commit**

  Run `bunx biome ci .`, then commit `feat(nav): project page rules in nav-path`.

### Task 2: Project pages and redirects

**Files:**
- Create: `web/routes/$locale/_app/$projectKey.issues.index.tsx` (the list at `/KEY/issues`)
- Create: `web/routes/$locale/_app/$projectKey.milestones.tsx`
- Create: `web/routes/$locale/_app/$projectKey.members.tsx`
- Modify: `web/routes/$locale/_app/$projectKey.index.tsx`. Remove the Tabs, the Releases and Edit-project header buttons, and the members/issues/milestones loaders. Keep the header, key badge, "New environment" and the cards. Change `ProjectPending` to header + grid with no tab strip.
- Modify: `web/routes/$locale/_app/$projectKey.$envSlug.issues.tsx`. It becomes a redirect only.
- Regenerate: `web/routeTree.gen.ts` with the repo's route generator (the same command the build uses; check `package.json`).
- Modify: `messages/*.json`. Add `breadcrumbs.milestones` and `breadcrumbs.members`, and page titles if the new pages need ones that do not exist yet (reuse `issues.title`, `projectOverview.milestones` and `projectOverview.members` where they fit).
- Test: `tests/project-pages-routes.test.ts` (new, source tests, following the pattern of `tests/releases-ui.test.tsx`)

**Interfaces:**
- **Consumes:** nothing from Task 1.
- **Produces:** the routes `/KEY/issues`, `/KEY/milestones` and `/KEY/members`, and the redirects.

- [ ] **Step 1: Write failing source tests.** Read each route file as text and assert:
  - `$projectKey.issues.index.tsx`:
    - uses `getProjectByKeyWithEnvironmentsQuery` and `notFound()`;
    - calls `requireProjectRole(queryClient, project.id)`;
    - renders `IssuesClient` with `currentEnvironmentId=""`;
    - its `validateSearch` keeps `status`.
  - `$projectKey.members.tsx` contains `requireProjectRole(` together with `member: ["manage"]`, and renders `ProjectMembersClient`.
  - `$projectKey.milestones.tsx` contains `requireProjectRole(` and renders `MilestonesClient`.
  - `$projectKey.$envSlug.issues.tsx`:
    - contains `redirect(`, targets `` `/${projectKey}/issues` ``, and passes the incoming search through;
    - no longer contains `IssuesClient`.
  - `$projectKey.index.tsx`:
    - does not contain `TabsList` or `/releases`;
    - redirects `tab` values `issues`, `milestones` and `members` to `/${projectKey}/<tab>`, keeping `status` for issues.
  - Every new key exists in all five `messages/*.json` (parse the JSON and check the paths).

- [ ] **Step 2: Run the tests and confirm they fail**

  Run: `bun --bun vitest run --maxWorkers=2 tests/project-pages-routes.test.ts`. Expected: FAIL (the files are missing).

- [ ] **Step 3: Implement the routes**
  - **Each new page** is `PageHeader` plus the body moved from the overview tab.
  - **Issues page:**
    - The page itself gets the issues loaders (issues by status, assignable users, milestones), moved from the overview.
    - `pendingComponent` is `IssuesPending`.
    - The page header uses `issues.title` and `issues.subtitle`.
  - **Redirects:** use `redirect` from `@/i18n/navigation`, with the search serialized to a query string.

- [ ] **Step 4: Run the tests, `tsc`, and the existing overview-related tests**

  First run the new tests plus `tests/releases-ui.test.tsx`. The latter asserted the overview's Releases button; update that assertion, since the sidebar now carries it (spec: "The overview's header buttons for Releases and Edit project go away"). Then run `tsc` separately. Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

  Run `bunx biome ci .`, then commit `feat(projects): issues, milestones and members as project pages`.

### Task 3: Sidebar project group

**Files:**
- Modify: `components/app-sidebar.tsx`
- Modify: `messages/*.json` (`nav.overview`, `nav.milestones`, `nav.members`, `nav.projectSettings`, `nav.environmentSettings`)
- Test: `tests/app-sidebar.test.tsx`

**Interfaces:**
- **Consumes:** `parseNavPath`, `projectNavItems` and `isProjectReleasable` from Task 1.
- **Produces:** nothing new for later tasks.

- [ ] **Step 1: Write failing tests** in `tests/app-sidebar.test.tsx`. Reuse the existing `renderSidebar` and `groupRows`, plus fixture `env(projectReleasable)` and `projects = [{ id: "p1", key: "CRMB", name: "CAR Membership" }]`, role `engineer`. Replace the describe block "Releases in the environment group" with:

```ts
describe("project group", () => {
  it("shows on a project page with every project item", async () => {
    await renderSidebar("member", "/CRMB/issues", { environments: [env(true)], projects, projectRoles: { p1: "engineer" } });
    expect(groupRows("CAR Membership")).toEqual(["Overview", "Issues", "Milestones", "Releases", "Members", "Settings"]);
  });
  it("shows above the environment group inside an environment", async () => {
    await renderSidebar("member", "/CRMB/dev/deploys", { /* same */ });
    const headings = [...container.querySelectorAll("h2")].map((h) => h.textContent);
    expect(headings.indexOf("CAR Membership")).toBeLessThan(headings.indexOf("Dev"));
  });
  it("keeps Releases and Issues out of the environment group", async () => {
    await renderSidebar("member", "/CRMB/dev/deploys", { /* same */ });
    expect(groupRows("Dev")).not.toContain("Releases");
    expect(groupRows("Dev")).not.toContain("Issues");
  });
  it("has no Releases entry for a container-only project", async () => { /* env(false) → groupRows lacks "Releases" */ });
  it("renders for a project without environments", async () => {
    await renderSidebar("member", "/CRMB", { environments: [], projects, projectRoles: { p1: "engineer" } });
    expect(groupRows("CAR Membership")).toContain("Overview");
    expect(groupRows("CAR Membership")).not.toContain("Releases");
  });
});
```

  Add one active-state test. The stubbed `SidebarMenuButton` drops `isActive`, so in this file's mock pass `isActive` through as `data-active` on the cloned link. Assert:
  - on `/CRMB/issues/42`, the Issues link has `data-active="true"` and the Overview link does not;
  - on `/CRMB`, Overview is active.

- [ ] **Step 2: Run the tests and confirm they fail**

  Run: `bun --bun vitest run --maxWorkers=2 tests/app-sidebar.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement the project group in `components/app-sidebar.tsx`**
  - **Which project:** the project of the active environment, or the project named by `nav.projectKey` on a project page.
  - **Items:** come from `projectNavItems(key, projectRoles[id] ?? null, isProjectReleasable(environments, id))`.
  - **Icons:**
    - overview `LayoutDashboard`
    - issues `CircleDot` (with the `badgeProjectOpen` badge from `openCounts[id]`)
    - milestones `Flag`
    - releases `PackageCheck`
    - members `Users`
    - settings `Settings` (tooltip `nav.projectSettings`)
  - **Active state:** Overview is active only on an exact `/KEY`. Every other item is active on `startsWith(href)`.
  - **Environment group:** drop `releases`, `issues` and the `projectLevel` field from `projectItems`. Rename that list to `environmentItems`. Its settings tooltip is `nav.environmentSettings`.

- [ ] **Step 4: Run the tests and confirm they pass** (same command as Step 2). Expected: PASS.

- [ ] **Step 5: Commit**

  Run `bunx biome ci .`, then commit `feat(nav): project group in the sidebar`.

### Task 4: Header breadcrumb on project pages

**Files:**
- Modify: `components/header-breadcrumb.tsx`
- Test: `tests/header-breadcrumb.test.ts` (new)

**Interfaces:**
- **Consumes:** `NavPath`, including `issueNumber`, and the `releasable` option of `projectSwitchHref` from Task 1.
- **Produces:** `export function getTrailingSegments(nav: NavPath, activeEnv: EnvironmentListItem | null): StaticSegment[]`. The function is already in this file; now it is exported. `StaticSegment` is exported too.

- [ ] **Step 1: Write failing tests**

```ts
it.each([
  ["/CRMB/issues", [{ labelKey: "breadcrumbs.issues" }]],
  ["/CRMB/milestones", [{ labelKey: "breadcrumbs.milestones" }]],
  ["/CRMB/members", [{ labelKey: "breadcrumbs.members" }]],
  ["/CRMB/releases", [{ labelKey: "breadcrumbs.releases" }]],
  ["/CRMB/settings", [{ labelKey: "breadcrumbs.settings" }]],
  ["/CRMB", []],
])("%s trails with %j", (path, expected) => {
  expect(getTrailingSegments(parseNavPath(path), null)).toMatchObject(expected);
});
it("links Issues and names the issue on a detail page", () => {
  expect(getTrailingSegments(parseNavPath("/CRMB/issues/42"), null)).toMatchObject([
    { href: "/CRMB/issues", labelKey: "breadcrumbs.issues" },
    { label: "CRMB-42" },
  ]);
});
```

  Add a render test: render `HeaderBreadcrumb` at `/CRMB/releases`, mocking `@/i18n/navigation` and the view-transition router the way `tests/app-sidebar.test.tsx` mocks navigation. Assert the text contains neither "Select environment" nor any environment switcher, and does contain "Releases".

- [ ] **Step 2: Run the tests and confirm they fail**

  Run: `bun --bun vitest run --maxWorkers=2 tests/header-breadcrumb.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**
  - Render `EnvironmentSwitcher` only when `nav.scope === "env"`.
  - Add the new cases to `getTrailingSegments`.
  - Pass `releasable: isProjectReleasable(environments, project.id)` to `projectSwitchHref`.

- [ ] **Step 4: Verify the whole branch**
  - Run the tests from Step 2.
  - Then run the full suite `bun --bun vitest run --maxWorkers=2`.
  - Then `tsc` (separately).
  - Then `bunx biome ci .`.
  - Expected: all green. Report the counts.

- [ ] **Step 5: Commit**

  Commit `feat(nav): project pages drop the environment switcher`.

## Not covered by this plan

- **Command palette:** no change. It lists only top-level pages, projects and environments, not sections (checked: `components/command-palette.tsx`).
- **Browser check of prod:** after release, open `/SCMB/issues`, `/CRMB/releases`, `/CRMB/dev/issues` (expect a redirect), `/CRMB?tab=members` (expect a redirect), and an issue detail.
