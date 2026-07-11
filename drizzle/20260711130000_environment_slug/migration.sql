-- Fase 5 (URL migration, Stage 1): a URL-friendly slug per environment, unique
-- within its project. Additive + backfilled; routing is unchanged (this is just
-- the data foundation). Safe while running.
BEGIN;

ALTER TABLE "environments" ADD COLUMN "slug" text;

-- Backfill from name: lowercase, non-alphanumerics → '-', trim dashes, empty →
-- 'env'. De-dupe within each project by appending the row number (so the first
-- keeps the clean slug, collisions get '-2', '-3', …).
WITH base AS (
	SELECT
		id,
		project_id,
		coalesce(
			nullif(trim(both '-' from lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g'))), ''),
			'env'
		) AS b
	FROM "environments"
),
ranked AS (
	SELECT
		id,
		b,
		row_number() OVER (PARTITION BY project_id, b ORDER BY id) AS rn
	FROM base
)
UPDATE "environments" e
SET "slug" = CASE WHEN r.rn = 1 THEN r.b ELSE r.b || '-' || r.rn END
FROM ranked r
WHERE e.id = r.id;

ALTER TABLE "environments" ALTER COLUMN "slug" SET NOT NULL;

CREATE UNIQUE INDEX "environments_project_slug_idx" ON "environments" ("project_id", "slug");

COMMIT;
