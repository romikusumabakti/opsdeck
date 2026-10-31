# UX polish pass — design

Date: 2026-10-31 · Status: decisions taken in brainstorming, builder-checked, awaiting user review

## Why

A screenshot review of every page found the UI already modern
(shadcn/Linear-style, command palette, breadcrumb switchers), but uneven in
three places: information architecture (names, badges, scroll), table
patterns (row actions, empty height, pagination), and noise (banners,
disabled buttons, raw ISO dates). This pass fixes those without adding
dependencies or redesigning the visual language.

## Goals

- Every count, name and date means one thing and reads the same everywhere.
- Every data table follows one pattern for row actions, sizing and
  pagination.
- Remove elements that add reading cost without adding information.
- A handful of small missing affordances (history filters, status tooltips,
  backup list, a11y labels).

## Non-goals

- No visual re-theme, no new component library, no new runtime dependency.
- No mobile redesign (keep existing responsive behaviour working).
- No translation of run descriptions already stored in the DB.
- The topbar clock stays as it is (with seconds) — explicitly decided.
- Issues stay reachable from the environment nav and keep listing the whole
  project — explicitly decided.

## Anti-goals

- Breaking URLs: environment slugs must not change.
- Losing data: the env-name migration must be reversible from its own
  output and must not run without a fresh backup.
- A half-applied pattern (some tables migrated, others not).

## Constraints

- Stack: Bun + Hono (`server/`), Vite + TanStack Router (`web/`), shared UI
  in `components/` (shadcn on `@base-ui/react`), Drizzle on Postgres.
- Every new UI string goes into all five `messages/*.json` (ar/en/es/id/zh).
- Migrations are hand-written `drizzle/<YYYYMMDDHHMMSS>_<name>/migration.sql`,
  `BEGIN…COMMIT`, additive, header comment citing this spec. Applied to the
  live DB (`dss_panel`) with `psql -v ON_ERROR_STOP=1` after a backup and a
  dry run. Claude applies it (user decision) but asks for go-ahead right
  before executing.
- Biome, `tsc --noEmit`, vitest and Playwright must stay green.

## Phases and decisions

Each phase is one commit (or a few), shippable on its own.

### Phase 1 — Information architecture

1. **Environment host field + short names** (user decision: new field +
   migration).
   - Add nullable `environments.host text` (free text, e.g.
     `56.129 / membership.sucor-int.id`). Shown wherever the env is listed
     or headed, as muted mono secondary text next to/under the short name;
     editable in the env form's Info section ("Host", optional, hint
     "Address or URL shown next to the name").
   - Migration backfill, per environment, in SQL:
     1. If `name` ends with `(…)`, move the parenthesised content into
        `host` and drop it (plus the preceding space) from `name`.
     2. If `name` then starts with the owning project's name followed by a
        space, strip that prefix.
     3. Trim. Never produce an empty name (skip rows that would).
     4. Skip any row whose new name would collide with another env in the
        same project (unique `(project_id, name)`); `RAISE NOTICE` the
        skipped ids so they can be fixed by hand.
   - Slugs are untouched.
   - Keep `stripProjectPrefix` (`lib/nav-path.ts`) as a display safety net
     for names edited later; delete the duplicate in
     `components/projects-overview.tsx` and use the shared one in the
     places that currently show the raw name: sidebar env label,
     dashboard/services/mock-time/mail subtitles, home "Jump back in" and
     attention list, issues board env chip.
   - Server-built strings that embed the env name (notifications, run
     progress, audit details, auto-created issue titles,
     `server/services/home.ts`) are shown in cross-project places (bell,
     admin activity, issue lists), so they use `Project · Env` going
     forward; existing audit rows keep what they stored.
   - Reversibility: the migration `RAISE NOTICE`s `id, old name → new name,
     host` for every changed row; the psql log is kept next to the backup.
     The pre-migration backup is the real rollback.
2. **Sidebar scroll.** Global nav (Home … Admin) stays fixed; only the
   contextual group (environment or admin sub-nav) scrolls when it
   overflows. Header and footer already stay fixed.
3. **Badges.** Global "Issues" badge keeps its meaning (open, assigned to
   me). Environment "Issues" badge changes to **all open issues in the
   project** (user decision). Add a tooltip on each badge saying what it
   counts.
4. **Env Issues subtitle** stays "for this project" (it is accurate under the
   decision above).
5. **Global Issues default = open only** (user decision): when the `status`
   param is absent, the table filters to `OPEN_STATUSES` (open +
   in progress), shown in the filter bar as "Active". Picking "All" writes
   an explicit `status=all`; single statuses (`status=open`, …) keep their
   current meaning. The board view is unchanged (it shows every status
   column). Existing saved views without a `status` param are rewritten to
   `status=all` in the same migration so they keep meaning what they meant
   when saved.
6. **Remove inline "+ New project"** from the environment form (user
   decision); keep "+ New server".

### Phase 2 — Table pattern

Applies to Servers, Storage, Admin Jira, Admin Tunnels (+ zones), Admin
Users, History, global Issues, env Issues.

1. **Row actions** (user decision): at most one primary action visible as an
   icon button with tooltip + `aria-label` (Servers/Storage: browse files;
   Jira/Tunnels: edit; Users: edit), everything else — including
   destructive actions — in a `⋯` dropdown. Destructive items are
   red text inside the menu and keep their existing confirm dialogs.
2. **Height:** tables hug their content. `fillHeight` only kicks in when the
   rows exceed the viewport (i.e. the bordered box has `max-height` of the
   remaining space instead of `flex-1`). No large empty white box for 1–5
   rows.
3. **Columns toggle** only when the table has more than 4 hideable columns.
4. **Pagination:** default page size 50 for client-side tables; the pager
   hides when everything fits on one page. Server-paged issues stay at 25.
5. **Compact status in issue rows** (Home "My issues", env Issues, global
   Issues): replace the full-width `StatusSelect` with a compact trigger
   (status icon/dot + label, auto width, no chevron box) that opens the same
   options. Frees width for titles.
6. **Global Issues columns:** Title gets a max width with truncation and a
   tooltip with the full title, so Status/Priority/Assignee/Project are
   visible at 1280 px without horizontal scroll.
7. **Truncated text** anywhere in tables/lists gets `title`/tooltip with the
   full value.

### Phase 3 — Dates and times

1. One module (`lib/format-date.ts` or extend an existing one) exposing:
   absolute date-time (`dateStyle: medium, timeStyle: short`), date only,
   and relative ("5 days ago" with absolute in tooltip). Uses the user's
   locale and IntlProvider time zone (`me.timeZone ?? APP_TIMEZONE`).
2. Replace date-fns `PPP`/`PPP HH:mm`/`PPP HH:mm:ss` display formats (mock
   time picker, mock-time API/legacy panels, live clock) with it, so mock
   time reads "Oct 31, 2026" like the rest.
3. Every relative time shows the absolute time on hover.
4. **Mock-time run descriptions** are built server-side from the ISO target.
   Going forward, format the target in `APP_TIMEZONE` as
   `yyyy-MM-dd HH:mm` plus zone abbreviation (e.g.
   `Mock time: travel to 2026-11-10 10:00 WIB`). Existing rows are left as
   is.

### Phase 4 — Noise removal and page fixes

1. **Services:** show Start *or* Stop by state (running → Stop; stopped →
   Start; unknown/not-found → both hidden, Restart disabled with reason),
   plus Restart and View logs. The "Status is checked over SSH…" banner
   becomes the Refresh button's tooltip.
2. **Home:** hide the "Running" card when nothing runs.
3. **Redundant subtitles** dropped where they repeat the title (People
   "Everyone in DSS Panel.", and any equivalent found while implementing);
   inaccurate ones fixed (Dashboard "Configuration overview for…" →
   describes the page; Databases subtitle → covers backup/restore/manage).
4. **Mock time:** "Backend API" badge uses the outline/secondary variant.
5. **Databases** (user decision): the Backup tab becomes a backup list —
   table of backup files (name, time, size) with "Run backup" in the card
   header and "Restore" per row (opens the existing restore flow
   pre-filled). No "by" column: nothing links a file to the run that wrote
   it. Restore tab stays for cross-environment restore; Manage stays.
   Gating: listing backups (server `getBackupList` and the client prefetch)
   requires backup **or** restore permission; the tab shows for either,
   with "Run backup" only for backup and "Restore" only for restore.
6. **Projects overview:** cards align to start (no stretched empty space);
   status icons get a tooltip + `aria-label` ("Last run succeeded / failed /
   running", with time).
7. **People:** deactivated users hidden by default, with a "Show
   deactivated" toggle (only for viewers who can see them today).

### Phase 5 — History filters and accessibility

1. **History faceted filters:** operation type (run `kind`), status, and
   user, next to the search box; URL-backed like the issues filters.
2. **Contrast:** raise `--muted-foreground` (light and dark) so secondary
   text reaches ≥ 4.5:1 on background and card; check the sidebar text over
   the motif watermark meets it too (lower motif opacity behind text if
   not).
3. **Icon-only buttons:** every one gets a tooltip and `aria-label`
   (sweep `size="icon"` usages).

## Left to the builder

- Exact component names/locations, test split, whether the compact status
  trigger is a new variant of `StatusSelect` or a new component.
- The primary row action per table if a better one is obvious from usage.
- How `max-height` is computed for hug-content tables.
- Exact new token values for contrast, as long as they meet 4.5:1.

## Claude's calls (not discussed with the user)

- Field name `host`, free text, not a URL.
- Backfill rules (paren → host, project-prefix strip, collision skip).
- Hide "Running" when empty; compact status trigger; page size 50; Columns
  threshold of > 4 hideable columns.
- Mock-time description format for new rows; old rows not rewritten.
- "Active" as the default issues status (table only), saved-view rewrite.
- `Project · Env` in cross-project server strings.
- Backup list without a "by" column; restore permission can list backups.
- Rollback = backup + per-row NOTICE log, no snapshot table.
- People presence ("Randy within working hours on Saturday"): no code bug
  found — it follows that user's saved days/timezone. No change.
