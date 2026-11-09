-- Indexes for the cross-project issue list.
--
-- The global list moved from "load every issue, filter in the browser" to a
-- SQL-side filter + sort + LIMIT/OFFSET. That makes three access paths hot on
-- the whole `issues` table (not scoped to one project, so the existing
-- `issues_project_status_idx` never applies):
--
--   * ORDER BY updated_at DESC — the default order of every page.
--   * WHERE assignee_id = ?    — the "assigned to me" toggle.
--   * WHERE status = ?         — the status dropdown.
--
-- Additive and non-destructive; safe to re-run.

CREATE INDEX IF NOT EXISTS "issues_updated_at_idx" ON "issues" ("updated_at" DESC);
CREATE INDEX IF NOT EXISTS "issues_assignee_idx" ON "issues" ("assignee_id");
CREATE INDEX IF NOT EXISTS "issues_status_idx" ON "issues" ("status");
