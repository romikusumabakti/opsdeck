# Home Page Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Home (`app/[locale]/(home)/page.tsx`) as a main column plus a right rail. The main column holds grouped, auto-resolving failures and my open issues; the rail holds live running runs and recently opened environments. The page also adds acknowledge, create-issue-from-failure, inline status, New issue and quick backup.

**Architecture:**
- The page is an RSC shell. The header and rail render immediately.
- The main column is one async server component inside `<Suspense>`. It loads attention, issues and access with `Promise.allSettled`, so a failing query only breaks its own card. It orders the sections with the pure `sectionOrder()`.
- Pure logic lives in `lib/home/attention.ts` and `lib/home/layout.ts`. Grouping and auto-resolve run in TypeScript over two small typed drizzle queries, which keeps them unit-testable.
- Mutations are server actions that call `revalidatePath("/[locale]", "page")`. Clients use `useOptimistic`.
- "Running" reads the existing SSE `ActiveRunsProvider`.

**Tech Stack:** Next.js 16.3 App Router, React 19.2 (`useOptimistic`, `useTransition`), drizzle-orm 1.0 rc (postgres-js), better-auth access control (`lib/permissions.ts`), shadcn base-vega on `@base-ui/react`, Tailwind 4, next-intl 4, sonner, `bun test` (happy-dom), Biome.

**Spec:** `docs/superpowers/specs/2026-10-03-home-rebuild-design.md`

## Deviations from the spec

The spec author has not reviewed these four changes. Each one keeps the spec's intent:

1. **Attention query.** The spec asked for one SQL query. This plan uses two typed drizzle queries plus the pure `groupFailures()`:
   - (a) unacknowledged failures in the window;
   - (b) the latest success per (environment, key) via `DISTINCT ON`.

   Reason: raw `db.execute` returns untyped rows and `timestamp` values as strings, and the pure grouping step can be unit-tested. The results are the same.
2. **Partial index columns.** The partial index is on `(run_at desc) where status = 'failed' and acknowledged_at is null`, not on `(environment_id, kind, run_at desc)`. Query (a) is a range scan on `run_at` across all environments, so that is the shape it can use. Query (b) uses the existing `runs_environment_run_idx`.
3. **Suspense and counts.** The spec described separate count queries plus one Suspense per section. In this plan the main column suspends as a single unit, because its order depends on both counts. The rail does not suspend: Running is client-only, and the recent-environments query is a single indexed lookup that the page also needs for the New-issue default.
4. **Greeting time zone.** The greeting uses the server-side `APP_TIMEZONE` (`lib/timezone.ts`, default `Asia/Jakarta`), not the browser's hour. The app already renders every time in `APP_TIMEZONE`, and a server-computed greeting cannot cause a hydration mismatch.

## Global Constraints

- Runtime and tooling: Bun (`bun test`, `bun run typecheck`, `bun run lint`, `bunx biome check --write <files>`). Never `npm`.
- Every new user-facing string goes in all five locales: `messages/{en,id,es,zh,ar}.json`. Indonesian uses "Anda".
- Server actions validate client-supplied ids with `uuidSchema` / zod **before** any lookup, and state their permission literally (for example `{ run: ["acknowledge"] }`). `tests/authz-guards.test.ts` checks both structurally.
- Cross-project reads must contain one of the scope helpers in `SCOPE_HELPERS` (`tests/authz-guards.test.ts`).
- Attention window: **7 days**. Attention group limit: **8**. My issues limit: **8**. Recent environments limit: **5**. Error excerpt in a prefilled issue: **2,000 characters**. Issue title max: **300 characters** (`issueInputSchema`).
- Grid: `grid-cols-1 lg:grid-cols-[minmax(0,1fr)_20rem]`.
- Commits: Conventional Commits. **No `Co-Authored-By: Claude` trailer** (repo rule).
- Migrations are hand-written SQL in `drizzle/<timestamp>_<name>/migration.sql`, wrapped in `BEGIN; … COMMIT;` and idempotent (`IF NOT EXISTS`). Do not run `drizzle-kit generate`: the snapshot chain is stale.

## Review Focus

1. **An error message containing ``` or longer than 2,000 characters.** The prefilled issue body must still render as one code block and be cut with "…". Owned by Task 3 (`failurePrefill` tests).
2. **The same failure key in two environments, or a success of a different kind in the same environment.** These must stay as separate groups and must not auto-resolve each other. Owned by Task 3 (`groupFailures` tests).
3. **A user with no project where they can write issues.** "New issue" and the per-failure "Issue" button must not show, and the default target must be `null`. Owned by Task 4 (`defaultIssueTarget` tests) and Task 10 (render guard).
4. **Undo clearing someone else's acknowledgement.** `unacknowledgeRuns` must only clear rows that the caller acknowledged. Owned by Task 6 (structural guard test).
5. **Greeting at hour boundaries and across the UTC date line** (for example 23:30 UTC is 06:30 in Jakarta). Owned by Task 4 (`hourIn` and `greetingKey` tests).

---

### Task 1: `run:acknowledge` project permission

**Files:**
- Modify: `lib/permissions.ts:68-106`
- Test: `tests/permissions.test.ts:129-147`

**Interfaces:**
- Produces: `canProject(role, { run: ["acknowledge"] })` is true for `contributor` and `maintainer` and false for `viewer`. `ProjectPermissions` accepts `{ run: ["acknowledge"] }`.

- [ ] **Step 1: Write the failing test.** In `tests/permissions.test.ts`, add this row to `PROJECT_MATRIX` after the `["member", "manage", …]` row:

```ts
  ["run", "acknowledge", { viewer: false, contributor: true, maintainer: true }],
```

- [ ] **Step 2: Run the test and confirm it fails.**

Run: `bun test tests/permissions.test.ts`
Expected: FAIL on `contributor can run:acknowledge` and `maintainer can run:acknowledge`.

- [ ] **Step 3: Implement.** In `lib/permissions.ts`:

Add a line to `projectStatements`, after `member: ["manage"],`:

```ts
  // Acknowledge a failed run so it leaves Home's "Needs attention" for everyone.
  run: ["acknowledge"],
```

Add a line to `contributorStatements`, after `database: ["backup", "restore"],`:

```ts
  run: ["acknowledge"],
```

Add a line to the `maintainer: projectAc.newRole({ … })` object, after `member: ["manage"],`:

```ts
    run: ["acknowledge"],
```

- [ ] **Step 4: Run the tests and confirm they pass.**

Run: `bun test tests/permissions.test.ts && bun run typecheck`
Expected: PASS, and no type errors.

- [ ] **Step 5: Commit.**

```bash
bunx biome check --write lib/permissions.ts tests/permissions.test.ts
git add lib/permissions.ts tests/permissions.test.ts
git commit -m "feat(authz): add run:acknowledge project permission"
```

---

### Task 2: Acknowledgement columns on `runs` and the migration

**Files:**
- Modify: `lib/db/schema.ts:258-296` (the `runs` table)
- Create: `drizzle/20261004000000_home_ack/migration.sql`

**Interfaces:**
- Produces:
  - `runs.acknowledgedAt: Date | null` and `runs.acknowledgedById: string | null` on the drizzle `runs` table and on the `Run` type.
  - Index `runs_attention_idx`.

- [ ] **Step 1: Edit the schema.** In `lib/db/schema.ts`, inside the `runs` column object, add these columns after `completedAt: timestamp("completed_at"),`:

```ts
    // Set when someone acknowledges a failed run on Home: it leaves "Needs
    // attention" for everyone. set null on user delete keeps the timestamp
    // (the run stays acknowledged) without pinning the user row.
    acknowledgedAt: timestamp("acknowledged_at"),
    acknowledgedById: uuid("acknowledged_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
```

In the same table's index array, after `index("runs_issue_idx").on(t.issueId),`, add:

```ts
    // Home's "Needs attention" scans unacknowledged failures in a recent
    // window across every environment, newest first.
    index("runs_attention_idx")
      .on(t.runAt.desc())
      .where(sql`${t.status} = 'failed' and ${t.acknowledgedAt} is null`),
```

- [ ] **Step 2: Write the migration.** Create `drizzle/20261004000000_home_ack/migration.sql`:

```sql
-- Home "Needs attention" acknowledgement
-- (docs/superpowers/specs/2026-10-03-home-rebuild-design.md).
-- Additive only: existing rows keep acknowledged_at NULL, i.e. unacknowledged.
BEGIN;

ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "acknowledged_at" timestamp;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "acknowledged_by_id" uuid;

DO $$
BEGIN
  ALTER TABLE "runs"
    ADD CONSTRAINT "runs_acknowledged_by_id_users_id_fk"
    FOREIGN KEY ("acknowledged_by_id") REFERENCES "public"."users"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "runs_attention_idx"
  ON "runs" USING btree ("run_at" DESC NULLS LAST)
  WHERE "runs"."status" = 'failed' AND "runs"."acknowledged_at" IS NULL;

COMMIT;
```

- [ ] **Step 3: Apply it to the local dev DB.**

```bash
docker compose up -d postgres
docker exec -i opsdeck-postgres psql -U postgres -d dss_panel -v ON_ERROR_STOP=1 \
  < drizzle/20261004000000_home_ack/migration.sql
docker exec -i opsdeck-postgres psql -U postgres -d dss_panel -c '\d runs' | grep -E 'acknowledged|runs_attention_idx'
```

Expected: the `acknowledged_at` and `acknowledged_by_id` columns and `runs_attention_idx` are listed. Run the migration a second time and expect `COMMIT` with no error, which shows it is idempotent.

- [ ] **Step 4: Typecheck.**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit.**

```bash
bunx biome check --write lib/db/schema.ts
git add lib/db/schema.ts drizzle/20261004000000_home_ack/migration.sql
git commit -m "feat(db): record who acknowledged a failed run"
```

---

### Task 3: Pure attention logic — `lib/home/attention.ts`

**Files:**
- Create: `lib/home/attention.ts`
- Test: `tests/home-attention.test.ts`

**Interfaces:**
- Produces:

```ts
export const ATTENTION_WINDOW_DAYS = 7;
export const ATTENTION_LIMIT = 8;
export const ERROR_EXCERPT_MAX = 2000;
export function attentionKey(run: { kind: string | null; description: string }): string;
export type FailureRow = {
  id: string; environmentId: string; kind: string | null; description: string;
  errorMessage: string | null; runAt: Date;
  environmentName: string; envPath: string; projectId: string;
};
export type SuccessRow = { environmentId: string; key: string; runAt: Date };
export type FailureGroup = {
  key: string; environmentId: string; environmentName: string; envPath: string;
  projectId: string; count: number;
  latest: { id: string; kind: string | null; description: string; errorMessage: string | null; runAt: Date };
};
export function groupFailures(failures: FailureRow[], successes: SuccessRow[], limit?: number): FailureGroup[];
export function failurePrefill(
  group: { latest: { description: string; errorMessage: string | null }; envPath: string },
  title: string,
  linkLabel: string
): { type: "bug"; title: string; description: string };
```

- [ ] **Step 1: Write the failing tests.** Create `tests/home-attention.test.ts`:

```ts
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
    expect(groups[0].count).toBe(6);
    expect(groups[0].latest.runAt).toEqual(at("2026-10-06T10:00:00Z"));
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
        { environmentId: "env-a", key: "backup", runAt: at("2026-10-04T00:00:00Z") },
        { environmentId: "env-b", key: "restore", runAt: at("2026-10-04T00:00:00Z") },
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
```

- [ ] **Step 2: Run the tests and confirm they fail.**

Run: `bun test tests/home-attention.test.ts`
Expected: FAIL with `Cannot find module '@/lib/home/attention'`.

- [ ] **Step 3: Implement.** Create `lib/home/attention.ts`:

```ts
// Pure grouping for Home's "Needs attention". Client-safe: no DB, no
// server-only imports, so the list component can reuse failurePrefill.

export const ATTENTION_WINDOW_DAYS = 7;
export const ATTENTION_LIMIT = 8;
export const ERROR_EXCERPT_MAX = 2000;
// issueInputSchema caps titles at 300.
const TITLE_MAX = 300;

// What makes two failures "the same problem". Legacy runs predate `kind`, so
// they fall back to their description. lib/home/queries.ts mirrors this in SQL
// as coalesce(kind::text, description).
export function attentionKey(run: {
  kind: string | null;
  description: string;
}): string {
  return run.kind ?? run.description;
}

export type FailureRow = {
  id: string;
  environmentId: string;
  kind: string | null;
  description: string;
  errorMessage: string | null;
  runAt: Date;
  environmentName: string;
  envPath: string;
  projectId: string;
};

export type SuccessRow = { environmentId: string; key: string; runAt: Date };

export type FailureGroup = {
  key: string;
  environmentId: string;
  environmentName: string;
  envPath: string;
  projectId: string;
  count: number;
  latest: {
    id: string;
    kind: string | null;
    description: string;
    errorMessage: string | null;
    runAt: Date;
  };
};

const groupId = (environmentId: string, key: string) =>
  `${environmentId}\u0000${key}`;

/**
 * Collapse unacknowledged failures into one group per (environment, key).
 * Drops a group when a success with the same key in the same environment is
 * newer than the group's latest failure (it has been fixed since). Newest
 * group first, capped at `limit`.
 */
export function groupFailures(
  failures: FailureRow[],
  successes: SuccessRow[],
  limit = ATTENTION_LIMIT
): FailureGroup[] {
  const lastSuccess = new Map<string, number>();
  for (const s of successes) {
    const id = groupId(s.environmentId, s.key);
    lastSuccess.set(
      id,
      Math.max(lastSuccess.get(id) ?? -Infinity, s.runAt.getTime())
    );
  }

  const groups = new Map<string, FailureGroup>();
  for (const f of failures) {
    const key = attentionKey(f);
    const id = groupId(f.environmentId, key);
    const latest = {
      id: f.id,
      kind: f.kind,
      description: f.description,
      errorMessage: f.errorMessage,
      runAt: f.runAt,
    };
    const existing = groups.get(id);
    if (!existing) {
      groups.set(id, {
        key,
        environmentId: f.environmentId,
        environmentName: f.environmentName,
        envPath: f.envPath,
        projectId: f.projectId,
        count: 1,
        latest,
      });
      continue;
    }
    existing.count += 1;
    if (f.runAt > existing.latest.runAt) existing.latest = latest;
  }

  return [...groups.entries()]
    .filter(
      ([id, g]) => (lastSuccess.get(id) ?? -Infinity) <= g.latest.runAt.getTime()
    )
    .map(([, g]) => g)
    .sort((a, b) => b.latest.runAt.getTime() - a.latest.runAt.getTime())
    .slice(0, limit);
}

// A fence longer than any backtick run inside the text, so an error that
// contains ``` can't close the block early.
function fenceFor(text: string): string {
  const longest = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length)
  );
  return "`".repeat(Math.max(3, longest + 1));
}

/** Prefill for "create an issue from this failure". */
export function failurePrefill(
  group: {
    latest: { description: string; errorMessage: string | null };
    envPath: string;
  },
  title: string,
  linkLabel: string
): { type: "bug"; title: string; description: string } {
  const parts = [group.latest.description];
  const error = group.latest.errorMessage?.trim();
  if (error) {
    const excerpt =
      error.length > ERROR_EXCERPT_MAX
        ? `${error.slice(0, ERROR_EXCERPT_MAX)}…`
        : error;
    const fence = fenceFor(excerpt);
    parts.push(`${fence}\n${excerpt}\n${fence}`);
  }
  parts.push(`[${linkLabel}](${group.envPath}/history)`);
  return {
    type: "bug",
    title: title.slice(0, TITLE_MAX),
    description: parts.join("\n\n"),
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass.**

Run: `bun test tests/home-attention.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit.**

```bash
bunx biome check --write lib/home/attention.ts tests/home-attention.test.ts
git add lib/home/attention.ts tests/home-attention.test.ts
git commit -m "feat(home): group failed runs into auto-resolving attention groups"
```

---

### Task 4: Pure layout helpers — `lib/home/layout.ts`

**Files:**
- Create: `lib/home/layout.ts`
- Test: `tests/home-layout.test.ts`

**Interfaces:**
- Produces:

```ts
export type SectionMode = "full" | "compact" | "hidden";
export type MainSection = { id: "attention" | "issues"; mode: SectionMode };
export function sectionOrder(input: { hasOpsAccess: boolean; attentionCount: number; issueCount: number }): MainSection[];
export type GreetingKey = "morning" | "midday" | "afternoon" | "night";
export function greetingKey(hour: number): GreetingKey;
export function hourIn(timeZone: string, date: Date): number;
export function firstName(name: string): string;
export function defaultIssueTarget(
  recent: { id: string; projectId: string }[],
  writableProjectIds: ReadonlySet<string>
): { projectId: string; environmentId: string } | null;
```

- [ ] **Step 1: Write the failing tests.** Create `tests/home-layout.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import {
  defaultIssueTarget,
  firstName,
  greetingKey,
  hourIn,
  sectionOrder,
} from "@/lib/home/layout";

describe("sectionOrder", () => {
  it("ops user with failures: attention first, full", () => {
    expect(
      sectionOrder({ hasOpsAccess: true, attentionCount: 2, issueCount: 5 })
    ).toEqual([
      { id: "attention", mode: "full" },
      { id: "issues", mode: "full" },
    ]);
  });

  it("ops user, all clear: issues first, attention compact", () => {
    expect(
      sectionOrder({ hasOpsAccess: true, attentionCount: 0, issueCount: 5 })
    ).toEqual([
      { id: "issues", mode: "full" },
      { id: "attention", mode: "compact" },
    ]);
  });

  it("non-ops user with no failures: attention hidden", () => {
    expect(
      sectionOrder({ hasOpsAccess: false, attentionCount: 0, issueCount: 3 })
    ).toEqual([
      { id: "issues", mode: "full" },
      { id: "attention", mode: "hidden" },
    ]);
  });

  it("non-ops user with issues and visible failures: issues first", () => {
    expect(
      sectionOrder({ hasOpsAccess: false, attentionCount: 1, issueCount: 3 })
    ).toEqual([
      { id: "issues", mode: "full" },
      { id: "attention", mode: "full" },
    ]);
  });

  it("no issues but failures: attention first, issues compact", () => {
    expect(
      sectionOrder({ hasOpsAccess: false, attentionCount: 1, issueCount: 0 })
    ).toEqual([
      { id: "attention", mode: "full" },
      { id: "issues", mode: "compact" },
    ]);
  });

  it("empty account: issues compact, attention hidden", () => {
    expect(
      sectionOrder({ hasOpsAccess: false, attentionCount: 0, issueCount: 0 })
    ).toEqual([
      { id: "issues", mode: "compact" },
      { id: "attention", mode: "hidden" },
    ]);
  });
});

describe("greetingKey", () => {
  it.each([
    [3, "night"],
    [4, "morning"],
    [10, "morning"],
    [11, "midday"],
    [14, "midday"],
    [15, "afternoon"],
    [17, "afternoon"],
    [18, "night"],
    [23, "night"],
    [0, "night"],
  ] as const)("hour %i → %s", (hour, key) => {
    expect(greetingKey(hour)).toBe(key);
  });
});

describe("hourIn", () => {
  it("converts to the target zone across the UTC date line", () => {
    expect(hourIn("Asia/Jakarta", new Date("2026-10-02T23:30:00Z"))).toBe(6);
  });
  it("returns 0, not 24, at midnight", () => {
    expect(hourIn("UTC", new Date("2026-10-03T00:15:00Z"))).toBe(0);
  });
});

describe("firstName", () => {
  it("takes the first word", () => {
    expect(firstName("Romi Kusuma Bakti")).toBe("Romi");
  });
  it("trims and handles single names", () => {
    expect(firstName("  Indri ")).toBe("Indri");
  });
  it("keeps an empty name empty", () => {
    expect(firstName("")).toBe("");
  });
});

describe("defaultIssueTarget", () => {
  const recent = [
    { id: "env1", projectId: "pA" },
    { id: "env2", projectId: "pB" },
  ];
  it("picks the most recent environment in a writable project", () => {
    expect(defaultIssueTarget(recent, new Set(["pB"]))).toEqual({
      projectId: "pB",
      environmentId: "env2",
    });
  });
  it("is null when the user can write nowhere", () => {
    expect(defaultIssueTarget(recent, new Set())).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**

Run: `bun test tests/home-layout.test.ts`
Expected: FAIL with `Cannot find module '@/lib/home/layout'`.

- [ ] **Step 3: Implement.** Create `lib/home/layout.ts`:

```ts
// Pure decisions for Home's layout and header. Client-safe.

export type SectionMode = "full" | "compact" | "hidden";
export type MainSection = { id: "attention" | "issues"; mode: SectionMode };

/**
 * Role adaptation, driven by data instead of a job-role field. Attention leads
 * when there is something to fix and the user either operates environments or
 * has no issues of their own. An ops user with nothing failing sees a compact
 * "all clear"; anyone else with nothing failing doesn't see the section.
 */
export function sectionOrder(input: {
  hasOpsAccess: boolean;
  attentionCount: number;
  issueCount: number;
}): MainSection[] {
  const { hasOpsAccess, attentionCount, issueCount } = input;
  const attention: MainSection = {
    id: "attention",
    mode: attentionCount > 0 ? "full" : hasOpsAccess ? "compact" : "hidden",
  };
  const issues: MainSection = {
    id: "issues",
    mode: issueCount > 0 ? "full" : "compact",
  };
  const attentionFirst =
    attentionCount > 0 && (issueCount === 0 || hasOpsAccess);
  return attentionFirst ? [attention, issues] : [issues, attention];
}

// Four buckets so Indonesian gets pagi/siang/sore/malam; other locales may map
// two buckets to the same phrase.
export type GreetingKey = "morning" | "midday" | "afternoon" | "night";

export function greetingKey(hour: number): GreetingKey {
  if (hour >= 4 && hour < 11) return "morning";
  if (hour >= 11 && hour < 15) return "midday";
  if (hour >= 15 && hour < 18) return "afternoon";
  return "night";
}

/** The wall-clock hour (0–23) of `date` in `timeZone`. */
export function hourIn(timeZone: string, date: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone,
    }).format(date)
  );
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/** Where "New issue" points by default: the last-opened writable environment. */
export function defaultIssueTarget(
  recent: { id: string; projectId: string }[],
  writableProjectIds: ReadonlySet<string>
): { projectId: string; environmentId: string } | null {
  const env = recent.find((e) => writableProjectIds.has(e.projectId));
  return env ? { projectId: env.projectId, environmentId: env.id } : null;
}
```

- [ ] **Step 4: Run the tests and confirm they pass.**

Run: `bun test tests/home-layout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
bunx biome check --write lib/home/layout.ts tests/home-layout.test.ts
git add lib/home/layout.ts tests/home-layout.test.ts
git commit -m "feat(home): data-driven section order and greeting helpers"
```

---

### Task 5: Home read queries — `lib/home/queries.ts`

**Files:**
- Create: `lib/home/queries.ts`
- Modify: `tests/authz-guards.test.ts:8-44` (`SCOPED_READS`, `SCOPE_HELPERS`)

**Interfaces:**
- Consumes: `groupFailures`, `ATTENTION_WINDOW_DAYS`, `FailureGroup` (Task 3); `run:acknowledge` (Task 1); `runs.acknowledgedAt` (Task 2).
- Produces (all `async`, all throw on DB error — callers use `Promise.allSettled` or `try`):

```ts
export type AttentionGroup = FailureGroup & { canAcknowledge: boolean };
export function getAttentionGroups(): Promise<AttentionGroup[]>;
export type MyIssue = { id: string; number: number; title: string; status: IssueStatus; projectKey: string; projectName: string };
export function listMyOpenIssues(limit?: number): Promise<{ items: MyIssue[]; total: number }>;
export type RecentEnvironment = { id: string; name: string; path: string; projectId: string; projectName: string; hasDatabase: boolean; canBackup: boolean };
export function listRecentEnvironments(limit?: number): Promise<RecentEnvironment[]>;
export type IssueProject = { id: string; name: string; key: string };
export function listIssueProjects(): Promise<IssueProject[]>;
export function getHomeAccess(): Promise<{ hasOpsAccess: boolean }>;
```

- [ ] **Step 1: Write the failing guard test.** In `tests/authz-guards.test.ts`, add this entry to `SCOPED_READS` after the `"actions/milestones.ts"` line:

```ts
  "lib/home/queries.ts": [
    "getAttentionGroups",
    "listMyOpenIssues",
    "listRecentEnvironments",
    "listIssueProjects",
    "getHomeAccess",
  ],
```

Then replace the `SCOPE_HELPERS` regex with:

```ts
const SCOPE_HELPERS =
  /projectScope|projectIdsWhere|requireProjectPage|requireProjectPermission|getProjectRole|getProjectAccess/;
```

- [ ] **Step 2: Run the test and confirm it fails.**

Run: `bun test tests/authz-guards.test.ts`
Expected: FAIL with `ENOENT … lib/home/queries.ts`.

- [ ] **Step 3: Implement.** Create `lib/home/queries.ts`:

```ts
import "server-only";

import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  type SQL,
  sql,
} from "drizzle-orm";
import { requireSession } from "@/lib/auth-session";
import { getProjectAccess, projectScope } from "@/lib/authz";
import { db } from "@/lib/db";
import {
  environmentAccess,
  environmentServices,
  environments,
  type IssueStatus,
  issues,
  projects,
  runs,
} from "@/lib/db/schema";
import {
  ATTENTION_WINDOW_DAYS,
  type FailureGroup,
  groupFailures,
} from "@/lib/home/attention";
import { canProject } from "@/lib/permissions";

// Read side of Home. Plain server functions (not actions): only the page's
// server components call them. Every one is scoped to the caller's projects and
// throws on DB failure so the page can render a per-card error instead of a
// misleading empty state.

// A run's grouping key, mirrored from attentionKey() in lib/home/attention.ts.
const runKey = sql<string>`coalesce(${runs.kind}::text, ${runs.description})`;

// Hard cap on failures scanned per render. 7 days of failures is normally a
// few dozen; this only bounds a pathological flood.
const FAILURE_SCAN_LIMIT = 500;

export type AttentionGroup = FailureGroup & { canAcknowledge: boolean };

export async function getAttentionGroups(): Promise<AttentionGroup[]> {
  await requireSession();
  const [scope, access] = await Promise.all([
    projectScope(environments.projectId),
    getProjectAccess(),
  ]);
  const since = new Date(Date.now() - ATTENTION_WINDOW_DAYS * 86_400_000);

  const failed = await db
    .select({
      id: runs.id,
      environmentId: runs.environmentId,
      kind: runs.kind,
      description: runs.description,
      errorMessage: runs.errorMessage,
      runAt: runs.runAt,
      environmentName: environments.name,
      envSlug: environments.slug,
      projectId: environments.projectId,
      projectKey: projects.key,
    })
    .from(runs)
    .innerJoin(environments, eq(environments.id, runs.environmentId))
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(
      and(
        eq(runs.status, "failed"),
        isNull(runs.acknowledgedAt),
        gte(runs.runAt, since),
        scope
      )
    )
    .orderBy(desc(runs.runAt))
    .limit(FAILURE_SCAN_LIMIT);
  if (failed.length === 0) return [];

  const envIds = [...new Set(failed.map((f) => f.environmentId))];
  // Latest success per (environment, key) since the window opened: anything
  // older can't be newer than a failure inside the window.
  const successes = await db
    .selectDistinctOn([runs.environmentId, runKey], {
      environmentId: runs.environmentId,
      key: runKey,
      runAt: runs.runAt,
    })
    .from(runs)
    .where(
      and(
        eq(runs.status, "success"),
        inArray(runs.environmentId, envIds),
        gte(runs.runAt, since)
      )
    )
    .orderBy(runs.environmentId, runKey, desc(runs.runAt));

  return groupFailures(
    failed.map((f) => ({
      ...f,
      envPath: `/${f.projectKey}/${f.envSlug}`,
    })),
    successes
  ).map((g) => ({
    ...g,
    canAcknowledge: canProject(access.roles[g.projectId] ?? null, {
      run: ["acknowledge"],
    }),
  }));
}

export type MyIssue = {
  id: string;
  number: number;
  title: string;
  status: IssueStatus;
  projectKey: string;
  projectName: string;
};

export async function listMyOpenIssues(
  limit = 8
): Promise<{ items: MyIssue[]; total: number }> {
  const session = await requireSession();
  const where: SQL | undefined = and(
    eq(issues.assigneeId, session.user.id),
    inArray(issues.status, ["open", "in_progress"]),
    await projectScope(issues.projectId)
  );
  const [items, [{ total }]] = await Promise.all([
    db
      .select({
        id: issues.id,
        number: issues.number,
        title: issues.title,
        status: issues.status,
        projectKey: projects.key,
        projectName: projects.name,
      })
      .from(issues)
      .innerJoin(projects, eq(projects.id, issues.projectId))
      .where(where)
      // Work already in progress first, then most recently touched.
      .orderBy(
        sql`${issues.status} = 'in_progress' desc`,
        desc(issues.updatedAt)
      )
      .limit(limit),
    db.select({ total: count() }).from(issues).where(where),
  ]);
  return { items, total };
}

export type RecentEnvironment = {
  id: string;
  name: string;
  path: string;
  projectId: string;
  projectName: string;
  hasDatabase: boolean;
  canBackup: boolean;
};

export async function listRecentEnvironments(
  limit = 5
): Promise<RecentEnvironment[]> {
  const session = await requireSession();
  const [scope, access] = await Promise.all([
    projectScope(environments.projectId),
    getProjectAccess(),
  ]);
  const rows = await db
    .select({
      id: environments.id,
      name: environments.name,
      slug: environments.slug,
      projectId: environments.projectId,
      projectKey: projects.key,
      projectName: projects.name,
      // EXISTS, not a join: only "has a db service" matters, and the service
      // row carries secret columns that must stay out of this projection.
      hasDatabase: sql<boolean>`exists (select 1 from ${environmentServices} where ${environmentServices.environmentId} = ${environments.id} and ${environmentServices.role} = 'db')`,
    })
    .from(environmentAccess)
    .innerJoin(
      environments,
      eq(environments.id, environmentAccess.environmentId)
    )
    .innerJoin(projects, eq(projects.id, environments.projectId))
    .where(and(eq(environmentAccess.userId, session.user.id), scope))
    .orderBy(desc(environmentAccess.lastAccessedAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    path: `/${r.projectKey}/${r.slug}`,
    projectId: r.projectId,
    projectName: r.projectName,
    hasDatabase: r.hasDatabase,
    canBackup: canProject(access.roles[r.projectId] ?? null, {
      database: ["backup"],
    }),
  }));
}

export type IssueProject = { id: string; name: string; key: string };

/** Projects where the caller may create issues — the New-issue picker. */
export async function listIssueProjects(): Promise<IssueProject[]> {
  await requireSession();
  const access = await getProjectAccess();
  const ids = Object.entries(access.roles)
    .filter(([, role]) => canProject(role, { issue: ["write"] }))
    .map(([id]) => id);
  if (ids.length === 0) return [];
  return db
    .select({ id: projects.id, name: projects.name, key: projects.key })
    .from(projects)
    .where(inArray(projects.id, ids))
    .orderBy(asc(projects.name));
}

/** Does the caller operate any environment? Drives the attention section. */
export async function getHomeAccess(): Promise<{ hasOpsAccess: boolean }> {
  await requireSession();
  const access = await getProjectAccess();
  return {
    hasOpsAccess: Object.values(access.roles).some((role) =>
      canProject(role, { run: ["acknowledge"] })
    ),
  };
}
```

- [ ] **Step 4: Run the tests and typecheck.**

Run: `bun test tests/authz-guards.test.ts && bun run typecheck`
Expected: PASS, and no type errors. If `issues.number` is named differently in `lib/db/schema.ts`, use the name `GlobalIssue` exposes as `number`.

- [ ] **Step 5: Smoke-run against the dev DB.** This is a manual check, not committed. Server-only modules can't run under plain `bun`, so verify the two attention queries in SQL instead:

```bash
docker exec -i opsdeck-postgres psql -U postgres -d dss_panel -c "EXPLAIN SELECT id FROM runs WHERE status='failed' AND acknowledged_at IS NULL AND run_at >= now() - interval '7 days' ORDER BY run_at DESC LIMIT 500;"
```

Expected: the plan mentions `runs_attention_idx`. On a tiny table it may show `Seq Scan`; re-run after `SET enable_seqscan = off;` in the same session to confirm the index is usable.

- [ ] **Step 6: Commit.**

```bash
bunx biome check --write lib/home/queries.ts tests/authz-guards.test.ts
git add lib/home/queries.ts tests/authz-guards.test.ts
git commit -m "feat(home): scoped read queries for attention, issues and recent envs"
```

---

### Task 6: Acknowledge and undo actions, plus audit entries

**Files:**
- Create: `actions/home.ts`
- Modify: `app/[locale]/admin/activity/page.tsx:136-145` (add two `case`s before `default:`)
- Modify: `messages/{en,id,es,zh,ar}.json` (the `activity` namespace)
- Modify: `tests/authz-guards.test.ts` (`SCOPED_WRITES` plus a new describe)

**Interfaces:**
- Consumes: `run:acknowledge` (Task 1); `runs.acknowledgedAt` and `runs.acknowledgedById` (Task 2).
- Produces:

```ts
export async function acknowledgeAttentionGroup(environmentId: string, key: string): Promise<ActionResponse<{ runIds: string[] }>>;
export async function unacknowledgeRuns(environmentId: string, runIds: string[]): Promise<ActionResponse>;
```

- Activity actions: `run.acknowledged` and `run.unacknowledged`, with data `{ environment: string; count: number }`.

- [ ] **Step 1: Write the failing guard tests.** In `tests/authz-guards.test.ts`, add this entry to `SCOPED_WRITES`:

```ts
  "actions/home.ts": {
    acknowledgeAttentionGroup: /run: \["acknowledge"\]/,
    unacknowledgeRuns: /run: \["acknowledge"\]/,
  },
```

Append this new describe block at the end of the file:

```ts
describe("home acknowledgement actions", () => {
  const source = readFileSync("actions/home.ts", "utf8");
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
```

- [ ] **Step 2: Run the tests and confirm they fail.**

Run: `bun test tests/authz-guards.test.ts`
Expected: FAIL with `ENOENT … actions/home.ts`.

- [ ] **Step 3: Implement the actions.** Create `actions/home.ts`:

```ts
"use server";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { recordActivity } from "@/lib/activity";
import { requireProjectPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { environments, runs } from "@/lib/db/schema";
import type { ActionResponse } from "@/lib/types";
import { uuidSchema } from "@/lib/validation";

// The attention key is a run kind or, for legacy runs, a description.
const keySchema = z.string().trim().min(1).max(1000);
const runIdsSchema = z.array(z.uuid()).min(1).max(500);

async function environmentName(environmentId: string): Promise<string> {
  const [row] = await db
    .select({ name: environments.name })
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);
  return row?.name ?? "";
}

/**
 * Acknowledge every unacknowledged failure of one attention group — global, so
 * it leaves Home for everyone. A later failure brings the group back.
 */
export async function acknowledgeAttentionGroup(
  environmentId: string,
  key: string
): Promise<ActionResponse<{ runIds: string[] }>> {
  if (
    !uuidSchema.safeParse(environmentId).success ||
    !keySchema.safeParse(key).success
  ) {
    return { success: false, message: "Invalid request" };
  }
  const { session } = await requireProjectPermission(
    { environmentId },
    { run: ["acknowledge"] }
  );
  try {
    const acked = await db
      .update(runs)
      .set({ acknowledgedAt: new Date(), acknowledgedById: session.user.id })
      .where(
        and(
          eq(runs.environmentId, environmentId),
          eq(runs.status, "failed"),
          isNull(runs.acknowledgedAt),
          sql`coalesce(${runs.kind}::text, ${runs.description}) = ${key}`
        )
      )
      .returning({ id: runs.id });
    if (acked.length > 0) {
      await recordActivity({
        actorId: session.user.id,
        action: "run.acknowledged",
        entityType: "run",
        entityId: acked[0].id,
        data: {
          environment: await environmentName(environmentId),
          count: acked.length,
        },
      });
    }
    revalidatePath("/[locale]", "page");
    return { success: true, data: { runIds: acked.map((r) => r.id) } };
  } catch (error) {
    console.error("Failed to acknowledge runs:", error);
    return { success: false, message: "Failed to acknowledge" };
  }
}

/** Undo for the acknowledge toast: only the caller's own acknowledgements. */
export async function unacknowledgeRuns(
  environmentId: string,
  runIds: string[]
): Promise<ActionResponse> {
  if (
    !uuidSchema.safeParse(environmentId).success ||
    !runIdsSchema.safeParse(runIds).success
  ) {
    return { success: false, message: "Invalid request" };
  }
  const { session } = await requireProjectPermission(
    { environmentId },
    { run: ["acknowledge"] }
  );
  try {
    const cleared = await db
      .update(runs)
      .set({ acknowledgedAt: null, acknowledgedById: null })
      .where(
        and(
          eq(runs.environmentId, environmentId),
          inArray(runs.id, runIds),
          eq(runs.acknowledgedById, session.user.id)
        )
      )
      .returning({ id: runs.id });
    if (cleared.length > 0) {
      await recordActivity({
        actorId: session.user.id,
        action: "run.unacknowledged",
        entityType: "run",
        entityId: cleared[0].id,
        data: {
          environment: await environmentName(environmentId),
          count: cleared.length,
        },
      });
    }
    revalidatePath("/[locale]", "page");
    return { success: true };
  } catch (error) {
    console.error("Failed to unacknowledge runs:", error);
    return { success: false, message: "Failed to undo" };
  }
}
```

- [ ] **Step 4: Render the audit entries.** In `app/[locale]/admin/activity/page.tsx`, add these cases inside `switch (row.action)`, just before `default:`:

```ts
    case "run.acknowledged":
      return t("runAcknowledged", {
        actor,
        count: Number(d.count),
        environment: String(d.environment),
      });
    case "run.unacknowledged":
      return t("runUnacknowledged", {
        actor,
        count: Number(d.count),
        environment: String(d.environment),
      });
```

In each locale's `activity` object, add two keys after `"userInvitationResent"` (add a comma to the preceding line):

| Locale | `runAcknowledged` | `runUnacknowledged` |
|---|---|---|
| en | `"{actor} acknowledged {count, plural, one {# failed run} other {# failed runs}} in {environment}"` | `"{actor} reopened {count, plural, one {# failed run} other {# failed runs}} in {environment}"` |
| id | `"{actor} menandai {count, plural, other {# run gagal}} di {environment} sudah ditangani"` | `"{actor} membuka kembali {count, plural, other {# run gagal}} di {environment}"` |
| es | `"{actor} reconoció {count, plural, one {# ejecución fallida} other {# ejecuciones fallidas}} en {environment}"` | `"{actor} reabrió {count, plural, one {# ejecución fallida} other {# ejecuciones fallidas}} en {environment}"` |
| zh | `"{actor} 确认了 {environment} 中的 {count, plural, other {# 次失败运行}}"` | `"{actor} 重新打开了 {environment} 中的 {count, plural, other {# 次失败运行}}"` |
| ar | `"أقرّ {actor} بـ {count, plural, one {تشغيل فاشل واحد} other {# عمليات تشغيل فاشلة}} في {environment}"` | `"أعاد {actor} فتح {count, plural, one {تشغيل فاشل واحد} other {# عمليات تشغيل فاشلة}} في {environment}"` |

- [ ] **Step 5: Run the tests, typecheck and validate the JSON.**

Run: `bun test tests/authz-guards.test.ts && bun run typecheck && for f in messages/*.json; do bun -e "JSON.parse(await Bun.file('$f').text())" || echo BAD $f; done`
Expected: PASS, no type errors, and no `BAD` lines.

- [ ] **Step 6: Commit.**

```bash
bunx biome check --write actions/home.ts "app/[locale]/admin/activity/page.tsx" tests/authz-guards.test.ts
git add actions/home.ts "app/[locale]/admin/activity/page.tsx" tests/authz-guards.test.ts messages/*.json
git commit -m "feat(home): acknowledge failed-run groups with audited undo"
```

---

### Task 7: Extract `IssueCreateDialog` and add `getIssueFormOptions`

**Files:**
- Create: `components/issue-create-dialog.tsx`
- Modify: `app/[locale]/[projectKey]/[envSlug]/issues/issues-client.tsx` (delete the local `CreateIssueDialog` at lines ~567-744 and `type EnvOption`, then import the shared one)
- Modify: `actions/issues.ts` (add `getIssueFormOptions`)
- Modify: `tests/authz-guards.test.ts` (`SCOPED_WRITES["actions/issues.ts"]`)

**Interfaces:**
- Produces:

```ts
// components/issue-create-dialog.tsx
export type Option = { id: string; name: string };
export type IssueDefaults = { title?: string; description?: string; type?: IssueType };
export function IssueCreateDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  environments: Option[];
  users: AssignableUser[];
  milestones: MilestoneOption[];
  defaultEnvironmentId: string;      // "" = None
  defaults?: IssueDefaults;          // must be referentially stable while open
  loading?: boolean;                 // disables Create (options still loading)
  projectPicker?: React.ReactNode;   // rendered above the title field
  onCreated: () => void;
}): React.JSX.Element;

// actions/issues.ts
export type IssueFormOptions = { environments: Option[]; users: { id: string; name: string }[]; milestones: Option[] };
export async function getIssueFormOptions(projectId: string): Promise<IssueFormOptions>;
```

- [ ] **Step 1: Write the failing guard test.** In `tests/authz-guards.test.ts`, inside `SCOPED_WRITES["actions/issues.ts"]`, add:

```ts
    getIssueFormOptions: /issue: \["write"\]/,
```

Run: `bun test tests/authz-guards.test.ts`
Expected: FAIL with `getIssueFormOptions not found`.

- [ ] **Step 2: Add the action.** In `actions/issues.ts`, add these imports at the top with the others:

```ts
import { listMilestones } from "@/actions/milestones";
import { getProjectWithEnvironments } from "@/actions/project-catalog";
import { listAssignableUsers } from "@/actions/users";
```

Append the function to the end of the file:

```ts
export type IssueFormOptions = {
  environments: { id: string; name: string }[];
  users: { id: string; name: string }[];
  milestones: { id: string; name: string }[];
};

/**
 * The pickers of the create-issue form for one project, for callers that
 * choose the project at runtime (Home's New issue). Gated on issue:write: the
 * form is useless without it.
 */
export async function getIssueFormOptions(
  projectId: string
): Promise<IssueFormOptions> {
  await requireProjectPermission({ projectId }, { issue: ["write"] });
  const [project, users, milestones] = await Promise.all([
    getProjectWithEnvironments(projectId),
    listAssignableUsers(projectId),
    listMilestones(projectId),
  ]);
  return {
    environments: (project?.environments ?? []).map((e) => ({
      id: e.id,
      name: e.name,
    })),
    users,
    milestones: milestones.map((m) => ({ id: m.id, name: m.name })),
  };
}
```

If `bun run typecheck` reports a circular-import problem with `actions/milestones.ts` or `actions/users.ts` (either importing `actions/issues.ts`), move `getIssueFormOptions` into a new file `actions/issue-form.ts` that starts with `"use server";` and has the same body. In that case, point the guard-test entry at `"actions/issue-form.ts": { getIssueFormOptions: /issue: \["write"\]/ }`.

- [ ] **Step 3: Create the shared dialog.** Create `components/issue-create-dialog.tsx`. It contains the old `CreateIssueDialog` body verbatim, with five changes:
  1. It is exported and renamed.
  2. It takes the `defaults` / `loading` / `projectPicker` props.
  3. The reset effect applies `defaults`.
  4. The environment, assignee and milestone values are checked against the current lists, so switching projects can't submit another project's id.
  5. The Create button is disabled while `loading`.

```tsx
"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { createIssue } from "@/actions/issues";
import {
  type AssignableUser,
  AssigneeSelect,
  type IssueType,
  type MilestoneOption,
  MilestoneSelect,
  type Priority,
  PrioritySelect,
  TypeSelect,
} from "@/components/issues-board";
import { MarkdownEditor } from "@/components/markdown-editor";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type Option = { id: string; name: string };
export type IssueDefaults = {
  title?: string;
  description?: string;
  type?: IssueType;
};

const NONE = "none";

export function IssueCreateDialog({
  open,
  onOpenChange,
  projectId,
  environments,
  users,
  milestones,
  defaultEnvironmentId,
  defaults,
  loading = false,
  projectPicker,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  environments: Option[];
  users: AssignableUser[];
  milestones: MilestoneOption[];
  defaultEnvironmentId: string;
  defaults?: IssueDefaults;
  loading?: boolean;
  projectPicker?: React.ReactNode;
  onCreated: () => void;
}) {
  const t = useTranslations("issues");
  const tCommon = useTranslations("common");

  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [type, setType] = React.useState<IssueType>("task");
  const [priority, setPriority] = React.useState<Priority>("medium");
  const [assigneeId, setAssigneeId] = React.useState<string | null>(null);
  const [milestoneId, setMilestoneId] = React.useState<string | null>(null);
  // Empty default (e.g. from the project overview, which has no "current" env)
  // falls back to the "None" option.
  const [environmentId, setEnvironmentId] = React.useState(
    defaultEnvironmentId || NONE
  );
  const [saving, setSaving] = React.useState(false);

  // Reset the form each time the dialog opens.
  React.useEffect(() => {
    if (open) {
      setTitle(defaults?.title ?? "");
      setDescription(defaults?.description ?? "");
      setType(defaults?.type ?? "task");
      setPriority("medium");
      setAssigneeId(null);
      setMilestoneId(null);
      setEnvironmentId(defaultEnvironmentId || NONE);
    }
  }, [open, defaultEnvironmentId, defaults]);

  // Selections only count while they belong to the current project's lists:
  // Home lets the project change under an open form, and a stale id would be
  // rejected server-side (or, worse, picked from the wrong project).
  const envValue = environments.some((e) => e.id === environmentId)
    ? environmentId
    : NONE;
  const assigneeValue =
    assigneeId && users.some((u) => u.id === assigneeId) ? assigneeId : null;
  const milestoneValue =
    milestoneId && milestones.some((m) => m.id === milestoneId)
      ? milestoneId
      : null;

  async function submit() {
    if (!title.trim() || loading) return;
    setSaving(true);
    const result = await createIssue({
      projectId,
      title: title.trim(),
      description: description.trim(),
      type,
      priority,
      environmentId: envValue === NONE ? null : envValue,
      assigneeId: assigneeValue,
      milestoneId: milestoneValue,
    });
    setSaving(false);
    if (!result.success) {
      toast.error(t("createFailed"));
      return;
    }
    toast.success(t("createdSuccess"));
    onCreated();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Capped to the viewport with the fields scrolling inside: the markdown
          editor's toolbar plus its writing surface make this form taller than a
          short screen, and without the cap the header and the Create button are
          the parts that fall off. The wider breakpoint keeps the toolbar on one
          row. */}
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-2xl max-h-[calc(100dvh-4rem)]">
        <DialogHeader>
          <DialogTitle>{t("createTitle")}</DialogTitle>
          <DialogDescription>{t("createDescription")}</DialogDescription>
        </DialogHeader>
        {/* px/py + the negative margin keep focus rings from being clipped by
            the scroll container's edges. */}
        <div className="-mx-1 flex flex-col gap-4 overflow-y-auto px-1 py-1">
          {projectPicker}
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium" htmlFor="issue-title">
              {t("titleLabel")}
            </label>
            <Input
              id="issue-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("titlePlaceholder")}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">{t("typeLabel")}</span>
              <TypeSelect value={type} onChange={setType} />
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">{t("priorityLabel")}</span>
              <PrioritySelect value={priority} onChange={setPriority} />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">{t("descriptionLabel")}</span>
            {/* Same markdown editor as the issue detail page, so what is typed
                here round-trips through the same parse/serialize. Shorter than
                the default surface — it sits in a dialog and grows as you
                type. */}
            <MarkdownEditor
              value={description}
              onChange={setDescription}
              contentClassName="min-h-[6rem]"
            />
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">{t("environmentLabel")}</span>
            <Select
              value={envValue}
              onValueChange={(v) => setEnvironmentId(v ?? NONE)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t("none")}</SelectItem>
                {environments.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">{t("assignee")}</span>
            <AssigneeSelect
              users={users}
              value={assigneeValue}
              onChange={setAssigneeId}
            />
          </div>
          {milestones.length > 0 ? (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">{t("milestone")}</span>
              <MilestoneSelect
                milestones={milestones}
                value={milestoneValue}
                onChange={setMilestoneId}
              />
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            {tCommon("cancel")}
          </Button>
          <Button
            type="button"
            onClick={submit}
            disabled={saving || loading || !title.trim()}
          >
            {saving ? t("creating") : t("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Point the issues page at it.** In `app/[locale]/[projectKey]/[envSlug]/issues/issues-client.tsx`:
  - Delete the whole `function CreateIssueDialog(...) { ... }`.
  - Delete `type EnvOption = { id: string; name: string };`.
  - Replace `EnvOption` in the `IssuesClient` props with `Option`.
  - Replace the JSX `<CreateIssueDialog` with `<IssueCreateDialog` (same props).
  - Add `import { IssueCreateDialog, type Option } from "@/components/issue-create-dialog";`.
  - Remove imports that are now unused. Biome reports them; likely candidates are `createIssue`, `AssigneeSelect`, `MilestoneSelect`, `PrioritySelect`, `TypeSelect`, `MarkdownEditor`, `Dialog*` and `Input`. Keep any the file still uses.

- [ ] **Step 5: Verify.**

Run: `bun test tests/authz-guards.test.ts && bun run typecheck && bun run lint`
Expected: PASS and no errors.

Manual check: run `bun run dev`, open any `/<KEY>/<env>/issues` page, click New issue, create an issue, and confirm it appears. Behaviour should be unchanged.

- [ ] **Step 6: Commit.**

```bash
bunx biome check --write components/issue-create-dialog.tsx "app/[locale]/[projectKey]/[envSlug]/issues/issues-client.tsx" actions/issues.ts tests/authz-guards.test.ts
git add components/issue-create-dialog.tsx "app/[locale]/[projectKey]/[envSlug]/issues/issues-client.tsx" actions/issues.ts tests/authz-guards.test.ts
git commit -m "refactor(issues): share the create-issue dialog with prefill support"
```

---

### Task 8: `home` i18n namespace

**Files:**
- Modify: `messages/{en,id,es,zh,ar}.json`. Add a top-level `"home"` object right after the existing `"inbox"` object. The page still uses `inbox` until Task 11, which deletes it.

**Interfaces:**
- Produces these keys, used by Tasks 9–11:
  - `home.title`, `home.subtitle`
  - `home.greeting.{morning,midday,afternoon,night}` (param `name`)
  - `home.newIssue`
  - `home.kind.{backup,restore,mock_time,test}`
  - `home.attention.{title,allClear,createIssue,acknowledge,acknowledged,ackFailed,undo,undoFailed,issueTitle,runHistory}`
  - `home.issues.{title,empty,viewAll,statusFailed}`
  - `home.running.{title,empty}`
  - `home.recent.{title,empty,backup,backupStarted,backupFailed}`
  - `home.issueDialog.{project,loadFailed}`
  - `home.error.{load,retry}`

- [ ] **Step 1: Add the blocks.** Insert into each file after the closing `},` of `"inbox"`:

**en**
```json
  "home": {
    "title": "Home",
    "subtitle": "Your work and what needs attention.",
    "greeting": {
      "morning": "Good morning, {name}",
      "midday": "Good afternoon, {name}",
      "afternoon": "Good afternoon, {name}",
      "night": "Good evening, {name}"
    },
    "newIssue": "New issue",
    "kind": { "backup": "Backup", "restore": "Restore", "mock_time": "Mock time", "test": "Test" },
    "attention": {
      "title": "Needs attention",
      "allClear": "All clear — no unresolved failures in the last 7 days.",
      "createIssue": "Issue",
      "acknowledge": "Ack",
      "acknowledged": "Acknowledged",
      "ackFailed": "Couldn't acknowledge the failure.",
      "undo": "Undo",
      "undoFailed": "Couldn't undo the acknowledgement.",
      "issueTitle": "{kind} failed: {environment}",
      "runHistory": "Run history"
    },
    "issues": {
      "title": "My issues",
      "empty": "Nothing assigned to you.",
      "viewAll": "View all ({count})",
      "statusFailed": "Couldn't update the status."
    },
    "running": { "title": "Running", "empty": "Nothing running." },
    "recent": {
      "title": "Jump back in",
      "empty": "No recent environments.",
      "backup": "Backup",
      "backupStarted": "Backup started",
      "backupFailed": "Couldn't start the backup."
    },
    "issueDialog": { "project": "Project", "loadFailed": "Couldn't load the project's options." },
    "error": { "load": "Couldn't load this section.", "retry": "Retry" }
  },
```

**id**
```json
  "home": {
    "title": "Beranda",
    "subtitle": "Pekerjaan Anda dan yang perlu perhatian.",
    "greeting": {
      "morning": "Selamat pagi, {name}",
      "midday": "Selamat siang, {name}",
      "afternoon": "Selamat sore, {name}",
      "night": "Selamat malam, {name}"
    },
    "newIssue": "Issue baru",
    "kind": { "backup": "Backup", "restore": "Restore", "mock_time": "Mock time", "test": "Uji" },
    "attention": {
      "title": "Perlu perhatian",
      "allClear": "Aman — tidak ada kegagalan yang belum ditangani dalam 7 hari terakhir.",
      "createIssue": "Issue",
      "acknowledge": "Tandai",
      "acknowledged": "Ditandai sudah ditangani",
      "ackFailed": "Gagal menandai kegagalan.",
      "undo": "Urungkan",
      "undoFailed": "Gagal mengurungkan.",
      "issueTitle": "{kind} gagal: {environment}",
      "runHistory": "Riwayat run"
    },
    "issues": {
      "title": "Issue saya",
      "empty": "Tidak ada tugas untuk Anda.",
      "viewAll": "Lihat semua ({count})",
      "statusFailed": "Gagal mengubah status."
    },
    "running": { "title": "Berjalan", "empty": "Tidak ada yang berjalan." },
    "recent": {
      "title": "Lanjutkan",
      "empty": "Belum ada environment terbaru.",
      "backup": "Backup",
      "backupStarted": "Backup dimulai",
      "backupFailed": "Gagal memulai backup."
    },
    "issueDialog": { "project": "Project", "loadFailed": "Gagal memuat opsi project." },
    "error": { "load": "Gagal memuat bagian ini.", "retry": "Coba lagi" }
  },
```

**es**
```json
  "home": {
    "title": "Inicio",
    "subtitle": "Tu trabajo y lo que necesita atención.",
    "greeting": {
      "morning": "Buenos días, {name}",
      "midday": "Buenas tardes, {name}",
      "afternoon": "Buenas tardes, {name}",
      "night": "Buenas noches, {name}"
    },
    "newIssue": "Nueva incidencia",
    "kind": { "backup": "Copia de seguridad", "restore": "Restauración", "mock_time": "Hora simulada", "test": "Prueba" },
    "attention": {
      "title": "Necesita atención",
      "allClear": "Todo en orden: sin fallos pendientes en los últimos 7 días.",
      "createIssue": "Incidencia",
      "acknowledge": "Reconocer",
      "acknowledged": "Reconocido",
      "ackFailed": "No se pudo reconocer el fallo.",
      "undo": "Deshacer",
      "undoFailed": "No se pudo deshacer.",
      "issueTitle": "{kind} fallida: {environment}",
      "runHistory": "Historial de ejecuciones"
    },
    "issues": {
      "title": "Mis incidencias",
      "empty": "No tienes nada asignado.",
      "viewAll": "Ver todo ({count})",
      "statusFailed": "No se pudo actualizar el estado."
    },
    "running": { "title": "En ejecución", "empty": "Nada en ejecución." },
    "recent": {
      "title": "Retomar",
      "empty": "No hay entornos recientes.",
      "backup": "Copia",
      "backupStarted": "Copia de seguridad iniciada",
      "backupFailed": "No se pudo iniciar la copia de seguridad."
    },
    "issueDialog": { "project": "Proyecto", "loadFailed": "No se pudieron cargar las opciones del proyecto." },
    "error": { "load": "No se pudo cargar esta sección.", "retry": "Reintentar" }
  },
```

**zh**
```json
  "home": {
    "title": "主页",
    "subtitle": "你的工作与需要关注的事项。",
    "greeting": {
      "morning": "早上好，{name}",
      "midday": "中午好，{name}",
      "afternoon": "下午好，{name}",
      "night": "晚上好，{name}"
    },
    "newIssue": "新建事项",
    "kind": { "backup": "备份", "restore": "恢复", "mock_time": "模拟时间", "test": "测试" },
    "attention": {
      "title": "需要关注",
      "allClear": "一切正常——过去 7 天内没有未处理的失败。",
      "createIssue": "事项",
      "acknowledge": "确认",
      "acknowledged": "已确认",
      "ackFailed": "无法确认该失败。",
      "undo": "撤销",
      "undoFailed": "无法撤销确认。",
      "issueTitle": "{kind}失败：{environment}",
      "runHistory": "运行历史"
    },
    "issues": {
      "title": "我的事项",
      "empty": "没有分配给你的事项。",
      "viewAll": "查看全部（{count}）",
      "statusFailed": "无法更新状态。"
    },
    "running": { "title": "运行中", "empty": "没有正在运行的任务。" },
    "recent": {
      "title": "快速返回",
      "empty": "暂无最近环境。",
      "backup": "备份",
      "backupStarted": "备份已开始",
      "backupFailed": "无法开始备份。"
    },
    "issueDialog": { "project": "项目", "loadFailed": "无法加载项目选项。" },
    "error": { "load": "无法加载此部分。", "retry": "重试" }
  },
```

**ar**
```json
  "home": {
    "title": "الرئيسية",
    "subtitle": "عملك وما يحتاج إلى انتباه.",
    "greeting": {
      "morning": "صباح الخير، {name}",
      "midday": "طاب يومك، {name}",
      "afternoon": "مساء الخير، {name}",
      "night": "مساء الخير، {name}"
    },
    "newIssue": "مشكلة جديدة",
    "kind": { "backup": "نسخ احتياطي", "restore": "استعادة", "mock_time": "وقت محاكى", "test": "اختبار" },
    "attention": {
      "title": "يحتاج انتباه",
      "allClear": "كل شيء على ما يرام — لا إخفاقات غير معالجة في آخر 7 أيام.",
      "createIssue": "مشكلة",
      "acknowledge": "إقرار",
      "acknowledged": "تم الإقرار",
      "ackFailed": "تعذّر الإقرار بالإخفاق.",
      "undo": "تراجع",
      "undoFailed": "تعذّر التراجع عن الإقرار.",
      "issueTitle": "فشل {kind}: {environment}",
      "runHistory": "سجل التشغيل"
    },
    "issues": {
      "title": "مشكلاتي",
      "empty": "لا شيء مُسنَد إليك.",
      "viewAll": "عرض الكل ({count})",
      "statusFailed": "تعذّر تحديث الحالة."
    },
    "running": { "title": "قيد التشغيل", "empty": "لا شيء قيد التشغيل." },
    "recent": {
      "title": "العودة السريعة",
      "empty": "لا بيئات حديثة.",
      "backup": "نسخ احتياطي",
      "backupStarted": "بدأ النسخ الاحتياطي",
      "backupFailed": "تعذّر بدء النسخ الاحتياطي."
    },
    "issueDialog": { "project": "المشروع", "loadFailed": "تعذّر تحميل خيارات المشروع." },
    "error": { "load": "تعذّر تحميل هذا القسم.", "retry": "إعادة المحاولة" }
  },
```

- [ ] **Step 2: Validate that all locales have identical key sets.**

```bash
bun -e '
const keys = (o, p = "") => Object.entries(o).flatMap(([k, v]) => typeof v === "object" ? keys(v, p + k + ".") : [p + k]);
const base = keys((await Bun.file("messages/en.json").json()).home).sort().join();
for (const l of ["id","es","zh","ar"]) {
  const k = keys((await Bun.file(`messages/${l}.json`).json()).home).sort().join();
  console.log(l, k === base ? "ok" : "MISMATCH");
}'
```

Expected: `id ok`, `es ok`, `zh ok`, `ar ok`.

- [ ] **Step 3: Commit.**

```bash
git add messages/*.json
git commit -m "feat(i18n): home namespace for the rebuilt Home page"
```

---

### Task 9: Main column — section shell, attention, my issues

**Files:**
- Create: `app/[locale]/(home)/_components/home-section.tsx`
- Create: `app/[locale]/(home)/_components/section-error.tsx`
- Create: `app/[locale]/(home)/_components/home-issue-dialog.tsx`
- Create: `app/[locale]/(home)/_components/attention-list.tsx`
- Create: `app/[locale]/(home)/_components/my-issues-list.tsx`
- Create: `app/[locale]/(home)/_components/main-column.tsx`

**Interfaces:**
- Consumes:
  - `getAttentionGroups`, `listMyOpenIssues`, `getHomeAccess`, `AttentionGroup`, `MyIssue`, `IssueProject` (Task 5)
  - `sectionOrder`, `SectionMode` (Task 4)
  - `failurePrefill` (Task 3)
  - `acknowledgeAttentionGroup`, `unacknowledgeRuns` (Task 6)
  - `IssueCreateDialog`, `IssueDefaults`, `getIssueFormOptions` (Task 7)
  - the `home.*` keys (Task 8)
- Produces:

```ts
export function HomeSection(props: { icon: LucideIcon; iconClassName?: string; title: string; count?: number; action?: React.ReactNode; children: React.ReactNode }): JSX.Element;
export function CompactSection(props: { icon: LucideIcon; iconClassName?: string; title: string; text: string }): JSX.Element;
export function SectionError(): JSX.Element;               // client
export function HomeIssueDialogProvider(props: { projects: IssueProject[]; defaultTarget: { projectId: string; environmentId: string } | null; children: React.ReactNode }): JSX.Element; // client
export function useIssueDialog(): { open: (prefill?: IssuePrefill) => void; canCreateIn: (projectId: string) => boolean; canCreate: boolean };
export type IssuePrefill = { projectId?: string; environmentId?: string | null } & IssueDefaults;
export function MainColumn(): Promise<JSX.Element>;      // server
```

- [ ] **Step 1: Write `home-section.tsx`.**

```tsx
import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// Card chrome shared by every Home section: icon + title + optional count and
// action in a header row, the list below.
export function HomeSection({
  icon: Icon,
  iconClassName,
  title,
  count,
  action,
  children,
}: {
  icon: LucideIcon;
  iconClassName?: string;
  title: string;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="py-0 gap-0 overflow-hidden">
      <CardContent className="p-0">
        <div className="flex items-center gap-2 px-3 py-2.5 border-b text-sm font-medium">
          <Icon
            className={cn("size-4 shrink-0 text-muted-foreground", iconClassName)}
          />
          <span className="flex-1 min-w-0 truncate">{title}</span>
          {count !== undefined ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {count}
            </span>
          ) : null}
          {action}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

// An empty section collapses to one line instead of a tall empty card.
export function CompactSection({
  icon: Icon,
  iconClassName,
  title,
  text,
}: {
  icon: LucideIcon;
  iconClassName?: string;
  title: string;
  text: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-xl border bg-card px-3 py-2.5 text-sm">
      <Icon
        className={cn("size-4 shrink-0 text-muted-foreground", iconClassName)}
      />
      <span className="font-medium shrink-0">{title}</span>
      <span className="min-w-0 truncate text-muted-foreground">{text}</span>
    </div>
  );
}
```

- [ ] **Step 2: Write `section-error.tsx`.**

```tsx
"use client";

import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";

export function SectionError() {
  const t = useTranslations("home");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-6 text-sm text-muted-foreground">
      <span>{t("error.load")}</span>
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => startTransition(() => router.refresh())}
      >
        {t("error.retry")}
      </Button>
    </div>
  );
}
```

- [ ] **Step 3: Write `home-issue-dialog.tsx`.**

```tsx
"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { getIssueFormOptions, type IssueFormOptions } from "@/actions/issues";
import {
  type IssueDefaults,
  IssueCreateDialog,
} from "@/components/issue-create-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRouter } from "@/i18n/navigation";
import type { IssueProject } from "@/lib/home/queries";

export type IssuePrefill = {
  projectId?: string;
  environmentId?: string | null;
} & IssueDefaults;

type DialogState = {
  open: boolean;
  projectId: string;
  environmentId: string | null;
  defaults: IssueDefaults;
};

type IssueDialogApi = {
  open: (prefill?: IssuePrefill) => void;
  canCreateIn: (projectId: string) => boolean;
  canCreate: boolean;
};

const IssueDialogContext = React.createContext<IssueDialogApi | null>(null);

export function useIssueDialog(): IssueDialogApi {
  const api = React.useContext(IssueDialogContext);
  if (!api) throw new Error("useIssueDialog outside HomeIssueDialogProvider");
  return api;
}

// One create-issue dialog for the whole page: the header's New issue and each
// failure's Issue button open it with different prefills. The project is
// picked inside the dialog; its pickers load on demand.
export function HomeIssueDialogProvider({
  projects,
  defaultTarget,
  children,
}: {
  projects: IssueProject[];
  defaultTarget: { projectId: string; environmentId: string } | null;
  children: React.ReactNode;
}) {
  const t = useTranslations("home");
  const router = useRouter();
  const [state, setState] = React.useState<DialogState | null>(null);
  const [options, setOptions] = React.useState<{
    projectId: string;
    data: IssueFormOptions;
  } | null>(null);

  const writable = React.useMemo(
    () => new Set(projects.map((p) => p.id)),
    [projects]
  );
  const projectId = state?.projectId ?? null;

  React.useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    getIssueFormOptions(projectId).then(
      (data) => {
        if (!cancelled) setOptions({ projectId, data });
      },
      () => {
        if (!cancelled) toast.error(t("issueDialog.loadFailed"));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, t]);

  const open = React.useCallback(
    (prefill: IssuePrefill = {}) => {
      const requested =
        prefill.projectId && writable.has(prefill.projectId)
          ? prefill.projectId
          : null;
      const pid = requested ?? defaultTarget?.projectId ?? projects[0]?.id;
      if (!pid) return;
      const environmentId = requested
        ? (prefill.environmentId ?? null)
        : pid === defaultTarget?.projectId
          ? defaultTarget.environmentId
          : null;
      setState({
        open: true,
        projectId: pid,
        environmentId,
        defaults: {
          title: prefill.title,
          description: prefill.description,
          type: prefill.type,
        },
      });
    },
    [writable, defaultTarget, projects]
  );

  const api = React.useMemo<IssueDialogApi>(
    () => ({
      open,
      canCreateIn: (id) => writable.has(id),
      canCreate: projects.length > 0,
    }),
    [open, writable, projects.length]
  );

  const current =
    options && options.projectId === projectId ? options.data : null;

  return (
    <IssueDialogContext.Provider value={api}>
      {children}
      {state ? (
        <IssueCreateDialog
          open={state.open}
          onOpenChange={(isOpen) =>
            setState((s) => (s ? { ...s, open: isOpen } : s))
          }
          projectId={state.projectId}
          environments={current?.environments ?? []}
          users={current?.users ?? []}
          milestones={current?.milestones ?? []}
          defaultEnvironmentId={state.environmentId ?? ""}
          defaults={state.defaults}
          loading={current === null}
          projectPicker={
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">
                {t("issueDialog.project")}
              </span>
              <Select
                value={state.projectId}
                onValueChange={(v) =>
                  v && setState((s) => (s ? { ...s, projectId: v } : s))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          }
          onCreated={() => {
            setState((s) => (s ? { ...s, open: false } : s));
            router.refresh();
          }}
        />
      ) : null}
    </IssueDialogContext.Provider>
  );
}
```

- [ ] **Step 4: Write `attention-list.tsx`.**

```tsx
"use client";

import { formatDistanceToNow } from "date-fns";
import { Check, CircleAlert, FilePlus2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { acknowledgeAttentionGroup, unacknowledgeRuns } from "@/actions/home";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { getDateFnsLocale } from "@/lib/date-fns-locale";
import { failurePrefill } from "@/lib/home/attention";
import type { AttentionGroup } from "@/lib/home/queries";
import { useIssueDialog } from "./home-issue-dialog";

const groupId = (g: AttentionGroup) => `${g.environmentId}\u0000${g.key}`;
const KINDS = ["backup", "restore", "mock_time", "test"] as const;

export function AttentionList({ groups }: { groups: AttentionGroup[] }) {
  const t = useTranslations("home");
  const locale = useLocale();
  const dfl = getDateFnsLocale(locale);
  const issueDialog = useIssueDialog();
  const [, startTransition] = React.useTransition();
  // The acknowledged row disappears at once; the action's revalidation brings
  // the fresh list that no longer contains it.
  const [visible, hide] = React.useOptimistic(groups, (cur, id: string) =>
    cur.filter((g) => groupId(g) !== id)
  );

  const kindLabel = (g: AttentionGroup) =>
    (KINDS as readonly string[]).includes(g.latest.kind ?? "")
      ? t(`kind.${g.latest.kind as (typeof KINDS)[number]}`)
      : g.latest.description;

  function undo(g: AttentionGroup, runIds: string[]) {
    startTransition(async () => {
      const res = await unacknowledgeRuns(g.environmentId, runIds);
      if (!res.success) toast.error(t("attention.undoFailed"));
    });
  }

  function acknowledge(g: AttentionGroup) {
    startTransition(async () => {
      hide(groupId(g));
      const res = await acknowledgeAttentionGroup(g.environmentId, g.key);
      if (!res.success) {
        toast.error(t("attention.ackFailed"));
        return;
      }
      toast.success(t("attention.acknowledged"), {
        action: {
          label: t("attention.undo"),
          onClick: () => undo(g, res.data.runIds),
        },
      });
    });
  }

  function createIssue(g: AttentionGroup) {
    issueDialog.open({
      projectId: g.projectId,
      environmentId: g.environmentId,
      ...failurePrefill(
        g,
        t("attention.issueTitle", {
          kind: kindLabel(g),
          environment: g.environmentName,
        }),
        t("attention.runHistory")
      ),
    });
  }

  return (
    <ul className="flex flex-col divide-y">
      {visible.map((g) => (
        <li
          key={groupId(g)}
          className="flex items-center gap-2 px-3 py-2 hover:bg-accent/50 transition-colors"
        >
          <CircleAlert className="size-3.5 shrink-0 text-destructive" />
          <Link
            href={`${g.envPath}/history`}
            title={g.latest.errorMessage ?? g.latest.description}
            className="flex min-w-0 flex-1 items-center gap-2"
          >
            <span className="truncate text-sm">
              {kindLabel(g)} · {g.environmentName}
            </span>
            {g.count > 1 ? (
              <Badge variant="destructive" className="shrink-0 tabular-nums">
                ×{g.count}
              </Badge>
            ) : null}
          </Link>
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
            {formatDistanceToNow(new Date(g.latest.runAt), {
              addSuffix: true,
              locale: dfl,
            })}
          </span>
          {issueDialog.canCreateIn(g.projectId) ? (
            <Button variant="ghost" size="xs" onClick={() => createIssue(g)}>
              <FilePlus2 />
              {t("attention.createIssue")}
            </Button>
          ) : null}
          {g.canAcknowledge ? (
            <Button variant="ghost" size="xs" onClick={() => acknowledge(g)}>
              <Check />
              {t("attention.acknowledge")}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 5: Write `my-issues-list.tsx`.**

```tsx
"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { setIssueStatus } from "@/actions/issues";
import { type Status, StatusSelect } from "@/components/issues-board";
import { Link } from "@/i18n/navigation";
import type { MyIssue } from "@/lib/home/queries";
import { cn } from "@/lib/utils";

export function MyIssuesList({ items }: { items: MyIssue[] }) {
  const t = useTranslations("home");
  const [, startTransition] = React.useTransition();
  const [rows, setOptimistic] = React.useOptimistic(
    items,
    (cur, change: { id: string; status: Status }) =>
      cur.map((i) => (i.id === change.id ? { ...i, status: change.status } : i))
  );

  function changeStatus(id: string, status: Status) {
    startTransition(async () => {
      setOptimistic({ id, status });
      // updateIssue revalidates Home, so resolved/closed rows drop out.
      const res = await setIssueStatus(id, status);
      if (!res.success) toast.error(t("issues.statusFailed"));
    });
  }

  return (
    <ul className="flex flex-col divide-y">
      {rows.map((i) => (
        <li
          key={i.id}
          className={cn(
            "flex items-center gap-3 px-3 py-1.5 transition-opacity",
            (i.status === "resolved" || i.status === "closed") && "opacity-50"
          )}
        >
          <Link
            href={`/${i.projectKey}/issues/${i.number}`}
            title={i.title}
            className="flex min-w-0 flex-1 items-center gap-3 hover:underline"
          >
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              {i.projectKey}-{i.number}
            </span>
            <span className="truncate text-sm">{i.title}</span>
          </Link>
          <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">
            {i.projectName}
          </span>
          <StatusSelect
            value={i.status as Status}
            onChange={(s) => changeStatus(i.id, s)}
            className="h-7 w-36 shrink-0"
          />
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 6: Write `main-column.tsx`.**

```tsx
import { CircleAlert, CircleCheck, CircleDot } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { type SectionMode, sectionOrder } from "@/lib/home/layout";
import {
  type AttentionGroup,
  getAttentionGroups,
  getHomeAccess,
  listMyOpenIssues,
  type MyIssue,
} from "@/lib/home/queries";
import { AttentionList } from "./attention-list";
import { CompactSection, HomeSection } from "./home-section";
import { MyIssuesList } from "./my-issues-list";
import { SectionError } from "./section-error";

// Suspends as one unit: the order of its two sections depends on both counts.
export async function MainColumn() {
  const [attention, issues, access] = await Promise.allSettled([
    getAttentionGroups(),
    listMyOpenIssues(),
    getHomeAccess(),
  ]);
  for (const r of [attention, issues, access]) {
    if (r.status === "rejected") console.error("Home section failed:", r.reason);
  }
  const order = sectionOrder({
    hasOpsAccess: access.status === "fulfilled" && access.value.hasOpsAccess,
    attentionCount:
      attention.status === "fulfilled" ? attention.value.length : 0,
    issueCount: issues.status === "fulfilled" ? issues.value.total : 0,
  });

  return (
    <>
      {order.map((s) =>
        s.id === "attention" ? (
          <AttentionSection key="attention" mode={s.mode} result={attention} />
        ) : (
          <MyIssuesSection key="issues" mode={s.mode} result={issues} />
        )
      )}
    </>
  );
}

async function AttentionSection({
  mode,
  result,
}: {
  mode: SectionMode;
  result: PromiseSettledResult<AttentionGroup[]>;
}) {
  if (mode === "hidden") return null;
  const t = await getTranslations("home");
  if (result.status === "fulfilled" && mode === "compact") {
    return (
      <CompactSection
        icon={CircleCheck}
        iconClassName="text-success"
        title={t("attention.title")}
        text={t("attention.allClear")}
      />
    );
  }
  return (
    <HomeSection
      icon={CircleAlert}
      iconClassName="text-destructive"
      title={t("attention.title")}
      count={result.status === "fulfilled" ? result.value.length : undefined}
    >
      {result.status === "fulfilled" ? (
        <AttentionList groups={result.value} />
      ) : (
        <SectionError />
      )}
    </HomeSection>
  );
}

async function MyIssuesSection({
  mode,
  result,
}: {
  mode: SectionMode;
  result: PromiseSettledResult<{ items: MyIssue[]; total: number }>;
}) {
  const t = await getTranslations("home");
  if (result.status === "fulfilled" && mode === "compact") {
    return (
      <CompactSection
        icon={CircleDot}
        title={t("issues.title")}
        text={t("issues.empty")}
      />
    );
  }
  return (
    <HomeSection
      icon={CircleDot}
      title={t("issues.title")}
      action={
        result.status === "fulfilled" ? (
          <Link
            href="/issues?mine=1"
            className="text-xs font-normal text-muted-foreground hover:text-foreground"
          >
            {t("issues.viewAll", { count: result.value.total })}
          </Link>
        ) : null
      }
    >
      {result.status === "fulfilled" ? (
        <MyIssuesList items={result.value.items} />
      ) : (
        <SectionError />
      )}
    </HomeSection>
  );
}
```

- [ ] **Step 7: Typecheck and lint.**

Run: `bun run typecheck && bun run lint`
Expected: no errors. These components aren't mounted yet; Task 11 wires them in.

- [ ] **Step 8: Commit.**

```bash
bunx biome check --write "app/[locale]/(home)/_components"
git add "app/[locale]/(home)/_components"
git commit -m "feat(home): attention and my-issues sections with inline actions"
```

---

### Task 10: Rail — live Running, Jump back in with quick backup, New issue button

**Files:**
- Create: `lib/elapsed.ts`
- Modify: `components/active-runs-indicator.tsx:16-29` (move `toMs` and `formatElapsed` into the new module and import them)
- Create: `app/[locale]/(home)/_components/running-rail.tsx`
- Create: `app/[locale]/(home)/_components/backup-button.tsx`
- Create: `app/[locale]/(home)/_components/recent-envs-section.tsx`
- Create: `app/[locale]/(home)/_components/new-issue-button.tsx`
- Test: `tests/elapsed.test.ts`

**Interfaces:**
- Consumes: `useActiveRuns` (`components/active-runs-provider.tsx`), `LiveRunDialog`, `createDatabaseBackup` (`actions/backups.ts`), `RecentEnvironment` (Task 5), `useIssueDialog` (Task 9), `HomeSection`, `CompactSection`, `SectionError` (Task 9).
- Produces:

```ts
export function formatElapsed(from: Date | string, now: number): string; // lib/elapsed.ts
export function RunningRail(): JSX.Element;                                // client
export function RecentEnvsSection(props: { environments: RecentEnvironment[] | null }): JSX.Element; // server; null = load failed
export function NewIssueButton(): JSX.Element | null;                      // client
```

- [ ] **Step 1: Write the failing test.** Create `tests/elapsed.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { formatElapsed } from "@/lib/elapsed";

describe("formatElapsed", () => {
  const start = new Date("2026-10-03T10:00:00Z");
  it("shows seconds under a minute", () => {
    expect(formatElapsed(start, start.getTime() + 42_000)).toBe("42s");
  });
  it("shows minutes and seconds", () => {
    expect(formatElapsed(start, start.getTime() + 125_000)).toBe("2m 5s");
  });
  it("accepts the ISO string a server action delivers", () => {
    expect(formatElapsed(start.toISOString(), start.getTime() + 1000)).toBe(
      "1s"
    );
  });
  it("never goes negative on clock skew", () => {
    expect(formatElapsed(start, start.getTime() - 5000)).toBe("0s");
  });
});
```

Run: `bun test tests/elapsed.test.ts`
Expected: FAIL with `Cannot find module '@/lib/elapsed'`.

- [ ] **Step 2: Extract the helpers.** Create `lib/elapsed.ts`:

```ts
// Server actions serialize Date to string over the wire — TS types still
// claim Date, so accept both at runtime to avoid NaN from .getTime().
function toMs(value: Date | string): number {
  return typeof value === "string" ? Date.parse(value) : value.getTime();
}

/** Compact running time of a run, e.g. "42s" or "2m 5s". */
export function formatElapsed(from: Date | string, now: number): string {
  const ms = Math.max(0, now - toMs(from));
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}
```

In `components/active-runs-indicator.tsx`, delete the local `toMs` and `formatElapsed` functions and add `import { formatElapsed } from "@/lib/elapsed";`.

Run: `bun test tests/elapsed.test.ts && bun run typecheck`
Expected: PASS, and no type errors.

- [ ] **Step 3: Write `running-rail.tsx`.**

```tsx
"use client";

import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { useActiveRuns } from "@/components/active-runs-provider";
import { LiveRunDialog } from "@/components/live-run-dialog";
import { useRouter } from "@/i18n/navigation";
import { formatElapsed } from "@/lib/elapsed";
import { CompactSection, HomeSection } from "./home-section";

export function RunningRail() {
  const t = useTranslations("home");
  const runs = useActiveRuns();
  const router = useRouter();
  const [now, setNow] = React.useState(() => Date.now());
  const [openRunId, setOpenRunId] = React.useState<string | null>(null);
  const [openTitle, setOpenTitle] = React.useState("");

  // Tick the elapsed time only while something is running.
  React.useEffect(() => {
    if (runs.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [runs.length]);

  // A run that left the list has finished: refresh once so "Needs attention"
  // and "Jump back in" reflect its outcome without a manual reload.
  const previous = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    const ids = new Set(runs.map((r) => r.id));
    const finished = [...previous.current].some((id) => !ids.has(id));
    previous.current = ids;
    if (finished) router.refresh();
  }, [runs, router]);

  return (
    <>
      {runs.length === 0 ? (
        <CompactSection
          icon={Loader2}
          title={t("running.title")}
          text={t("running.empty")}
        />
      ) : (
        <HomeSection
          icon={Loader2}
          iconClassName="animate-spin text-primary"
          title={t("running.title")}
          count={runs.length}
        >
          <ul className="flex flex-col divide-y">
            {runs.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => {
                    setOpenTitle(run.description);
                    setOpenRunId(run.id);
                  }}
                  className="flex w-full flex-col items-start px-3 py-2 text-left transition-colors hover:bg-accent/50"
                >
                  <span className="w-full truncate text-sm" title={run.description}>
                    {run.description}
                  </span>
                  <span className="w-full truncate text-xs text-muted-foreground">
                    {run.environment?.name ?? "—"} ·{" "}
                    <span className="tabular-nums">
                      {formatElapsed(run.runAt, now)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </HomeSection>
      )}
      <LiveRunDialog
        runId={openRunId}
        onOpenChange={(isOpen) => {
          if (!isOpen) setOpenRunId(null);
        }}
        title={openTitle}
      />
    </>
  );
}
```

- [ ] **Step 4: Write `backup-button.tsx`.**

```tsx
"use client";

import { DatabaseBackup } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";
import { createDatabaseBackup } from "@/actions/backups";
import { Button } from "@/components/ui/button";

// The new run shows up in the Running rail through the shared SSE stream.
export function BackupButton({ environmentId }: { environmentId: string }) {
  const t = useTranslations("home");
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="ghost"
      size="xs"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          try {
            await createDatabaseBackup(environmentId);
            toast.success(t("recent.backupStarted"));
          } catch {
            toast.error(t("recent.backupFailed"));
          }
        })
      }
    >
      <DatabaseBackup />
      {t("recent.backup")}
    </Button>
  );
}
```

- [ ] **Step 5: Write `recent-envs-section.tsx`.**

```tsx
import { ChevronRight, ServerCog } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import type { RecentEnvironment } from "@/lib/home/queries";
import { BackupButton } from "./backup-button";
import { CompactSection, HomeSection } from "./home-section";
import { SectionError } from "./section-error";

export function RecentEnvsSection({
  environments,
}: {
  environments: RecentEnvironment[] | null;
}) {
  const t = useTranslations("home");
  if (environments && environments.length === 0) {
    return (
      <CompactSection
        icon={ServerCog}
        title={t("recent.title")}
        text={t("recent.empty")}
      />
    );
  }
  return (
    <HomeSection icon={ServerCog} title={t("recent.title")}>
      {environments === null ? (
        <SectionError />
      ) : (
        <ul className="flex flex-col divide-y">
          {environments.map((env) => (
            <li
              key={env.id}
              className="group flex items-center gap-1 pe-2 transition-colors hover:bg-accent/50"
            >
              <Link
                href={env.path}
                title={`${env.name} — ${env.projectName}`}
                className="flex min-w-0 flex-1 flex-col px-3 py-2"
              >
                <span className="truncate text-sm">{env.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {env.projectName}
                </span>
              </Link>
              {env.hasDatabase && env.canBackup ? (
                <BackupButton environmentId={env.id} />
              ) : (
                <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              )}
            </li>
          ))}
        </ul>
      )}
    </HomeSection>
  );
}
```

- [ ] **Step 6: Write `new-issue-button.tsx`.**

```tsx
"use client";

import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { useIssueDialog } from "./home-issue-dialog";

export function NewIssueButton() {
  const t = useTranslations("home");
  const issueDialog = useIssueDialog();
  if (!issueDialog.canCreate) return null;
  return (
    <Button onClick={() => issueDialog.open()}>
      <Plus />
      {t("newIssue")}
    </Button>
  );
}
```

- [ ] **Step 7: Typecheck, lint, test.**

Run: `bun test && bun run typecheck && bun run lint`
Expected: all pass.

- [ ] **Step 8: Commit.**

```bash
bunx biome check --write lib/elapsed.ts tests/elapsed.test.ts components/active-runs-indicator.tsx "app/[locale]/(home)/_components"
git add lib/elapsed.ts tests/elapsed.test.ts components/active-runs-indicator.tsx "app/[locale]/(home)/_components"
git commit -m "feat(home): live running rail, recent environments with quick backup"
```

---

### Task 11: Assemble the page and remove the old Home code

**Files:**
- Modify (rewrite): `app/[locale]/(home)/page.tsx`
- Modify (rewrite): `app/[locale]/(home)/loading.tsx`
- Modify: `actions/runs.ts:300-345` (delete `HomeRun` and `getRecentFailedRuns`)
- Modify: `actions/issues.ts:247-280` (delete `listAssignedIssues`; keep `OPEN_STATUSES`, which other functions use)
- Modify: `tests/authz-guards.test.ts` (delete the `"listAssignedIssues"` and `"getRecentFailedRuns"` entries)
- Modify: `messages/{en,id,es,zh,ar}.json` (delete the `"inbox"` object)

**Interfaces:**
- Consumes everything from Tasks 4, 5, 9 and 10.

- [ ] **Step 1: Rewrite `page.tsx`.**

```tsx
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/auth-session";
import {
  defaultIssueTarget,
  firstName,
  greetingKey,
  hourIn,
} from "@/lib/home/layout";
import {
  listIssueProjects,
  listRecentEnvironments,
  type RecentEnvironment,
} from "@/lib/home/queries";
import { APP_TIMEZONE } from "@/lib/timezone";
import { HomeIssueDialogProvider } from "./_components/home-issue-dialog";
import { MainColumn } from "./_components/main-column";
import { MainColumnSkeleton } from "./_components/skeletons";
import { NewIssueButton } from "./_components/new-issue-button";
import { RecentEnvsSection } from "./_components/recent-envs-section";
import { RunningRail } from "./_components/running-rail";

// Main column: what needs the user (failures, their issues) — streamed, and
// ordered by what it contains. Rail: context (live runs, recent environments).
export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await requireSession();

  const [t, issueProjects, recent] = await Promise.all([
    getTranslations("home"),
    listIssueProjects(),
    listRecentEnvironments().catch((error: unknown): RecentEnvironment[] | null => {
      console.error("Home recent environments failed:", error);
      return null;
    }),
  ]);
  const target = defaultIssueTarget(
    recent ?? [],
    new Set(issueProjects.map((p) => p.id))
  );
  const greeting = t(`greeting.${greetingKey(hourIn(APP_TIMEZONE, new Date()))}`, {
    name: firstName(session.user.name),
  });

  return (
    <HomeIssueDialogProvider projects={issueProjects} defaultTarget={target}>
      <PageHeader
        title={greeting}
        subtitle={t("subtitle")}
        action={<NewIssueButton />}
      />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <Suspense fallback={<MainColumnSkeleton />}>
            <MainColumn />
          </Suspense>
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          <RunningRail />
          <RecentEnvsSection environments={recent} />
        </aside>
      </div>
    </HomeIssueDialogProvider>
  );
}
```

- [ ] **Step 2: Create `_components/skeletons.tsx` and rewrite `loading.tsx`.**

`app/[locale]/(home)/_components/skeletons.tsx`:

```tsx
import { Skeleton } from "@/components/ui/skeleton";

// Bars are `h-5`, not `h-4`: the rows they stand in for hold `text-sm`, whose
// 20px line box — not the 14px glyphs — is what sets the row height.
function CardSkeleton({ rows }: { rows: number }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <Skeleton className="size-4 shrink-0" />
        <Skeleton className="h-5 w-32" />
      </div>
      <ul className="flex flex-col divide-y">
        {Array.from({ length: rows }, (_, r) => (
          <li key={`row-${r}`} className="flex items-center gap-3 px-3 py-2">
            <Skeleton className="size-3.5 shrink-0 rounded-full" />
            <Skeleton className="h-5 max-w-[60%] flex-1" />
            <Skeleton className="h-3 w-16 shrink-0" />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MainColumnSkeleton() {
  return (
    <>
      <CardSkeleton rows={3} />
      <CardSkeleton rows={5} />
    </>
  );
}

export function RailSkeleton() {
  return (
    <>
      <Skeleton className="h-10 w-full rounded-xl" />
      <CardSkeleton rows={4} />
    </>
  );
}
```

`app/[locale]/(home)/loading.tsx`:

```tsx
import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { MainColumnSkeleton, RailSkeleton } from "./_components/skeletons";

// Home lives in a `(home)` route group purely so this file can exist: a
// `loading.tsx` directly under `[locale]` would also become the fallback for
// sign-in, setup and every other unshielded route, which render outside the
// app shell and have nothing in common with this layout.
export default function Loading() {
  return (
    <>
      <PageHeaderSkeleton withAction />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <MainColumnSkeleton />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <RailSkeleton />
        </div>
      </div>
    </>
  );
}
```

If `PageHeaderSkeleton` has no `withAction` prop that accepts `true`, check its signature in `components/skeletons/page-header-skeleton.tsx` and pass what renders a button placeholder.

- [ ] **Step 3: Delete the old code.**
  - `actions/runs.ts`: delete `export type HomeRun = {…}` and the whole `getRecentFailedRuns` function, including its doc comment.
  - `actions/issues.ts`: delete `listAssignedIssues` and its doc comment. If `GlobalIssue` or `attachLabels` become unused, Biome will say so; keep them if anything else uses them.
  - `tests/authz-guards.test.ts`: delete the `"listAssignedIssues",` and `"getRecentFailedRuns",` lines.
  - `messages/*.json`: delete the whole `"inbox": { … },` object in all five files.

Then confirm nothing still references them:

```bash
grep -rn "listAssignedIssues\|getRecentFailedRuns\|HomeRun\|\"inbox\"\|getTranslations(\"inbox\")" --include=*.ts --include=*.tsx --include=*.json . | grep -v node_modules
```

Expected: no output.

- [ ] **Step 4: Run the full gate.**

Run: `bun test && bun run typecheck && bun run lint`
Expected: all pass.

- [ ] **Step 5: Commit.**

```bash
bunx biome check --write "app/[locale]/(home)" actions/runs.ts actions/issues.ts tests/authz-guards.test.ts
git add "app/[locale]/(home)" actions/runs.ts actions/issues.ts tests/authz-guards.test.ts messages/*.json
git commit -m "feat(home): rebuild Home as main column + rail"
```

---

### Task 12: Verify against seeded data and in the browser

**Files:**
- Create (not committed): `/tmp/home-seed.sql`

- [ ] **Step 1: Seed the attention cases into the dev DB.** Pick one environment id: `docker exec -i opsdeck-postgres psql -U postgres -d dss_panel -c "select id, name from environments limit 3;"`. Put it in `ENV` and a second one in `ENV2`. Then write `/tmp/home-seed.sql`:

```sql
\set env '''REPLACE_ENV'''
\set env2 '''REPLACE_ENV2'''
BEGIN;
-- 1) six failed restores, same env → 1 group ×6
INSERT INTO runs (environment_id, description, status, kind, error_message, run_at, completed_at)
SELECT :env, 'Restore database seed', 'failed', 'restore', 'pg_restore: error: seed', now() - (i || ' hours')::interval, now() - (i || ' hours')::interval
FROM generate_series(1, 6) i;
-- 2) failure then later success (backup) → no group
INSERT INTO runs (environment_id, description, status, kind, run_at, completed_at) VALUES
 (:env, 'Backup database (seed)', 'failed', 'backup', now() - interval '3 hours', now() - interval '3 hours'),
 (:env, 'Backup database (seed)', 'success', 'backup', now() - interval '2 hours', now() - interval '2 hours');
-- 3) failure older than 7 days (mock_time) → no group
INSERT INTO runs (environment_id, description, status, kind, run_at, completed_at) VALUES
 (:env, 'Mock time seed', 'failed', 'mock_time', now() - interval '8 days', now() - interval '8 days');
-- 4) legacy kind-less failures on env2 → grouped by description ×2
INSERT INTO runs (environment_id, description, status, run_at, completed_at) VALUES
 (:env2, 'Legacy seed job', 'failed', now() - interval '1 hour', now() - interval '1 hour'),
 (:env2, 'Legacy seed job', 'failed', now() - interval '2 hours', now() - interval '2 hours');
COMMIT;
```

Run:

```bash
sed -i "s/REPLACE_ENV2/$ENV2/; s/REPLACE_ENV/$ENV/" /tmp/home-seed.sql
docker exec -i opsdeck-postgres psql -U postgres -d dss_panel -v ON_ERROR_STOP=1 < /tmp/home-seed.sql
```

- [ ] **Step 2: Check the page as an admin.** Run `bun run dev`, sign in as an admin, and open `/`. Expect:
  - "Needs attention" shows "Restore · <env>" with **×6**, and "Legacy seed job · <env2>" with **×2**.
  - No backup group and no mock-time group.

Then:
  - Click **Ack** on the restore group. It disappears at once, and a toast with **Undo** shows.
  - Click **Undo**. The group comes back.
  - Ack it again and leave it acknowledged.
  - Insert one more failed restore for `ENV` (copy the statement from case 1, with `generate_series(1,1)`) and reload. The group is back with **×1**.
  - Open `/admin/activity`. Entries for "acknowledged", "reopened" and "acknowledged" are there.

- [ ] **Step 3: Check the actions.**
  - Click **Issue** on a group. The dialog opens with the project, the environment, type Bug, the title "Restore failed: <env>", and a description with the error code block and a "Run history" link. Create it.
  - Change an issue's status in "My issues" to In progress. It moves to the top on refresh.
  - Change one to Resolved. It fades, then drops out.
  - Click **Backup** on an environment that has a db. "Running" switches from the compact line to a live card with the elapsed time. When the backup finishes, the card collapses back without a manual reload.
  - Click **New issue** in the header. The default project and environment are the most recent writable ones. Switching the project keeps the typed title.

- [ ] **Step 4: Screenshot three profiles.**
  - **ops:** the admin account from Step 2.
  - **developer:** a `member` with `contributor` on one project that has assigned issues. Attention shows for that project, and the order follows `sectionOrder`.
  - **empty:** a `member` with only `viewer` memberships and no issues. Expect My issues "Nothing assigned to you." as a compact line, attention hidden, and no New-issue button.

  Also check light/dark mode, a viewport of 375 px or less (the rail stacks below), and `ar` (RTL: badges and buttons mirror correctly).

- [ ] **Step 5: Clean up the seed rows.**

```bash
docker exec -i opsdeck-postgres psql -U postgres -d dss_panel -c "DELETE FROM runs WHERE description IN ('Restore database seed','Backup database (seed)','Mock time seed','Legacy seed job');"
```

- [ ] **Step 6: Final gate.**

Run: `bun test && bun run typecheck && bun run lint && bun run build`
Expected: all pass; the build completes.

- [ ] **Step 7: Rollout note.** Not part of this branch's commits. Before deploying, apply `drizzle/20261004000000_home_ack/migration.sql` to the live `dss_panel` database. Use the documented VPN + SSH procedure and take a backup first. The migration is additive and idempotent.
