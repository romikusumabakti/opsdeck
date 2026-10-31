-- Environment URL + owner as a user relation (user request 2026-10-31, env URL
-- + owner relation).
-- 1. Additive nullable columns: `url` (where the app opens in a browser) and
--    `owner_id` (the owning user; ON DELETE SET NULL). The old running build
--    ignores both, but the new build selects them in full-row queries, so this
--    MUST be applied before deploying the build that reads url/owner_id.
--    The free-text `owner` column stays for now: no new code reads or writes
--    it, and a later migration drops it after the deploy.
-- 2. Backfill:
--    a. URL: a `host` carrying a path ("56.129/membership.example.id") is
--       split into host = the part before the first '/', and
--       url = 'https://' || the part after it. Hosts without '/' are untouched.
--    b. Owner: the text after the last ' — ' of `owner` (else the whole text),
--       trimmed, matched case-insensitively against non-banned users by full
--       name, first name, or name prefix. Assigned only when exactly one user
--       matches; otherwise skipped with a NOTICE.
BEGIN;

ALTER TABLE "environments" ADD COLUMN IF NOT EXISTS "url" text;
ALTER TABLE "environments" ADD COLUMN IF NOT EXISTS "owner_id" uuid;

ALTER TABLE "environments"
  ADD CONSTRAINT "environments_owner_id_users_id_fk"
  FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id")
  ON DELETE set null ON UPDATE no action;

CREATE INDEX IF NOT EXISTS "environments_owner_idx"
  ON "environments" ("owner_id");

DO $$
DECLARE
  r record;
  new_host text;
  new_url text;
  wanted text;
  pattern text;
  matches int;
  match_id uuid;
  match_name text;
BEGIN
  -- a. Split a path out of host into url.
  FOR r IN
    SELECT id, name, host, url FROM environments
    WHERE host LIKE '%/%'
    ORDER BY name
  LOOP
    new_host := nullif(btrim(split_part(r.host, '/', 1)), '');
    new_url := nullif(btrim(substr(r.host, strpos(r.host, '/') + 1)), '');
    IF new_url IS NOT NULL THEN
      new_url := 'https://' || new_url;
    END IF;
    UPDATE environments
    SET host = new_host, url = coalesce(r.url, new_url)
    WHERE id = r.id;
    RAISE NOTICE 'env % (%): host % -> % | url %',
      r.id, r.name, r.host, new_host, coalesce(r.url, new_url);
  END LOOP;

  -- b. Link the free-text owner to a user.
  FOR r IN
    SELECT id, name, owner FROM environments
    WHERE owner IS NOT NULL AND owner_id IS NULL
    ORDER BY name
  LOOP
    -- Greedy: everything up to the LAST ' — ' goes, dropping a role prefix.
    wanted := lower(btrim(regexp_replace(r.owner, '^.* — ', '')));
    IF wanted = '' THEN
      RAISE NOTICE 'skip env % (%): owner % is empty after trimming',
        r.id, r.name, r.owner;
      CONTINUE;
    END IF;
    -- LIKE prefix with the wildcards in the owner text escaped.
    pattern := replace(replace(replace(wanted, '\', '\\'), '%', '\%'), '_', '\_')
      || '%';

    SELECT count(*), min(u.id::text)::uuid, min(u.name)
    INTO matches, match_id, match_name
    FROM users u
    WHERE u.banned = false
      AND (
        lower(u.name) = wanted
        OR lower(split_part(u.name, ' ', 1)) = wanted
        OR lower(u.name) LIKE pattern
      );

    IF matches <> 1 THEN
      RAISE NOTICE 'skip env % (%): owner % matches % users',
        r.id, r.name, r.owner, matches;
      CONTINUE;
    END IF;

    UPDATE environments SET owner_id = match_id WHERE id = r.id;
    RAISE NOTICE 'env % (%): owner % -> % (%)',
      r.id, r.name, r.owner, match_name, match_id;
  END LOOP;
END
$$;

COMMIT;
