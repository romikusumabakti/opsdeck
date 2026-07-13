-- Rename the misleading `project_id` FK columns that actually reference
-- `environments` (a deployment), not `projects` (the logical app). The names
-- were kept "for continuity" with the old single-level model; this makes the
-- schema say what it means. Pure rename — no data moves. Deploy the app together
-- with this migration, since Drizzle now maps `environmentId` (there is no
-- expand/contract window: renames are atomic and the old name disappears).
BEGIN;

-- runs.project_id → environment_id. A run (backup/restore/mock-time/test) acts
-- on exactly one environment.
ALTER TABLE "runs" RENAME COLUMN "project_id" TO "environment_id";
ALTER INDEX "runs_project_run_idx" RENAME TO "runs_environment_run_idx";

-- project_access → environment_access. Per-user MRU recency is over the thing
-- opened, which is an environment.
ALTER TABLE "project_access" RENAME TO "environment_access";
ALTER TABLE "environment_access" RENAME COLUMN "project_id" TO "environment_id";
ALTER INDEX "project_access_user_recency_idx"
  RENAME TO "environment_access_user_recency_idx";

-- NOTE: the underlying PK / FK CONSTRAINT names (e.g.
-- "runs_project_id_environments_id_fk", "project_access_user_id_project_id_pk")
-- keep their old text. They are internal identifiers only — renaming them is
-- cosmetic and risks a name mismatch, so they are intentionally left as-is.

COMMIT;
