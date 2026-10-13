-- Per-user accent colour (docs/superpowers/specs/2026-10-12-accent-colors-design.md).
-- Additive and nullable: NULL means "brand default", and the running build
-- ignores the column, so this can be applied before the deploy. No CHECK
-- constraint: the app validates against lib/accents.ts ACCENTS and falls back
-- on unknown values, so adding a colour later needs no migration.
BEGIN;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "accent_color" text;

COMMIT;
