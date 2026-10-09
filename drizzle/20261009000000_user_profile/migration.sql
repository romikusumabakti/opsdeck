-- User profiles: self-managed identity fields, status and avatar provenance.
-- All columns nullable, no backfill.
--
-- Pre-flight (run first; both must return zero rows):
--   SELECT lower(name), count(*) FROM users WHERE NOT banned
--     GROUP BY 1 HAVING count(*) > 1;
--   SELECT id FROM projects WHERE key = 'PEOPLE';
--
-- One transaction: if the unique index fails on a duplicate name, the
-- columns roll back too instead of being left half-applied.
BEGIN;

ALTER TABLE "users" ADD COLUMN "title" text;
ALTER TABLE "users" ADD COLUMN "bio" text;
ALTER TABLE "users" ADD COLUMN "timezone" text;
ALTER TABLE "users" ADD COLUMN "working_hours" jsonb;
ALTER TABLE "users" ADD COLUMN "status_emoji" text;
ALTER TABLE "users" ADD COLUMN "status_text" text;
ALTER TABLE "users" ADD COLUMN "status_expires_at" timestamp;
ALTER TABLE "users" ADD COLUMN "avatar_source" text;
CREATE UNIQUE INDEX "users_active_name_lower_idx" ON "users" (lower("name")) WHERE "banned" = false;

COMMIT;
