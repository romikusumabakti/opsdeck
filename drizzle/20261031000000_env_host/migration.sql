-- Environment host + short names (docs/superpowers/specs/2026-10-31-ux-polish-design.md,
-- Phase 1 items 1 and 5).
-- 1. Additive nullable column: free-text address shown next to the short name;
--    never used to connect. The running build ignores it, so this can be
--    applied before the deploy.
-- 2. Backfill: split a trailing "(host)" out of the name into `host`, and drop
--    the redundant project-name prefix (mirrors stripProjectPrefix in
--    lib/nav-path.ts). Rows that would end up with an empty name, or that
--    would collide with a sibling's name, are skipped with a NOTICE. Slugs
--    never change.
-- 3. Saved views without a status filter now mean "all" explicitly, because
--    the issues list is changing its default to "active".
BEGIN;

ALTER TABLE "environments" ADD COLUMN IF NOT EXISTS "host" text;

DO $$
DECLARE
  r record;
  env_host text;
  base text;
  tail text;
BEGIN
  FOR r IN
    SELECT e.id, e.project_id, e.name, e.host AS current_host, p.name AS project_name
    FROM environments e
    JOIN projects p ON p.id = e.project_id
    ORDER BY p.name, e.name
  LOOP
    env_host := substring(r.name from '\(([^()]*)\)\s*$');
    IF env_host IS NOT NULL THEN
      base := regexp_replace(r.name, '\s*\([^()]*\)\s*$', '');
    ELSE
      base := r.name;
    END IF;

    -- Strip the project-name prefix, only when a separator follows it and
    -- something remains after that.
    IF r.project_name <> ''
       AND lower(left(base, length(r.project_name))) = lower(r.project_name) THEN
      tail := substr(base, length(r.project_name) + 1);
      IF tail ~ '^[\s:–—-]' AND btrim(regexp_replace(tail, '^[\s:–—-]+', '')) <> '' THEN
        base := regexp_replace(tail, '^[\s:–—-]+', '');
      END IF;
    END IF;

    base := btrim(base);
    env_host := nullif(btrim(coalesce(env_host, '')), '');

    IF base = '' OR (base = r.name AND env_host IS NULL) THEN
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM environments o
      WHERE o.project_id = r.project_id AND o.id <> r.id AND o.name = base
    ) THEN
      RAISE NOTICE 'skip % (%): collides with existing name %', r.id, r.name, base;
      CONTINUE;
    END IF;

    UPDATE environments
    SET name = base, host = coalesce(r.current_host, env_host)
    WHERE id = r.id;
    RAISE NOTICE 'env % : % -> % | host %', r.id, r.name, base, env_host;
  END LOOP;
END
$$;

UPDATE "saved_views"
SET "params" = "params" || '{"status":"all"}'::jsonb
WHERE NOT "params" ? 'status';

COMMIT;
