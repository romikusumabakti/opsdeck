-- Per-user background motif (docs/superpowers/specs/2026-10-14-nusantara-motifs-design.md).
-- Additive and nullable: NULL means "daily rotation", otherwise 'none' or a
-- slug from lib/motifs.ts. The running build ignores the column, so this can
-- be applied before the deploy. No CHECK constraint: the app validates and
-- falls back to daily on unknown values, so adding or removing a motif needs
-- no migration.
BEGIN;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "motif" text;

COMMIT;
