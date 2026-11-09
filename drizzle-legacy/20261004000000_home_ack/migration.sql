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

-- Backfill runs.kind for ops runs created before actions/backups.ts and
-- actions/mock-time.ts set it, so Home groups them by kind rather than by
-- per-run description. Idempotent: only touches rows whose kind is still NULL.
-- Prefixes cover every description those actions write or have written:
--   backup:    "Backup database (<db>[, uncompressed])"
--   restore:   "Restore database <db> from <file>[ (+ restart backend)]",
--              older "Restore database from <file>" and "Restore <db> from <file>"
--   mock_time: "Mock time: travel/freeze/advance/reset ...", "Mock time to <ts> (legacy)",
--              "Advance clock by ... (legacy)", "Reset clock to real time (legacy)",
--              pre-rename "Simulate time to <ts>[ (legacy)]", and live-only legacy
--              "Travel clock ..." / "Bekukan clock ..." (found in dss_panel)
-- No other run description starts with these (databases.ts: Create/Drop/Rename
-- database; services.ts: Start/Stop/Restart ... service).
UPDATE "runs" SET "kind" = 'backup'
  WHERE "kind" IS NULL AND "description" LIKE 'Backup database%';
UPDATE "runs" SET "kind" = 'restore'
  WHERE "kind" IS NULL AND "description" LIKE 'Restore %';
UPDATE "runs" SET "kind" = 'mock_time'
  WHERE "kind" IS NULL AND (
    "description" LIKE 'Mock time%'
    OR "description" LIKE 'Advance clock%'
    OR "description" LIKE 'Reset clock%'
    OR "description" LIKE 'Simulate time%'
    OR "description" LIKE 'Travel clock%'
    OR "description" LIKE 'Bekukan clock%'
  );

COMMIT;
