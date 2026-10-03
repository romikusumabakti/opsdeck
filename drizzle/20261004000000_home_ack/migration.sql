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
