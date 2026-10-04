-- Re-key Microsoft accounts from the `sub` claim to `oid` for better-auth 1.7.
-- 1.6 stored the ID token's `sub` (pairwise, per-app) as accounts.account_id;
-- 1.7 looks Microsoft accounts up by `oid` (the stable directory object id)
-- and has no fallback. Unmigrated rows miss that lookup: invited users get a
-- second account row, and users whose email_verified is false are locked out
-- of Microsoft sign-in (account_not_linked).
--
-- The oid comes from the ID token better-auth stored at sign-in (1.6 keeps it
-- unencrypted in accounts.id_token). A row is only touched while its stored
-- token's `sub` still equals account_id, so this is idempotent and never
-- rewrites a row from a token that belongs to someone else.
--
-- Apply BEFORE deploying the better-auth 1.7 build, and as close to it as
-- possible: the 1.6 build matches by `sub` and cannot find migrated rows.
BEGIN;

WITH tokens AS (
  SELECT
    "id",
    "account_id",
    convert_from(
      decode(
        rpad(
          translate(split_part("id_token", '.', 2), '-_', '+/'),
          ((length(split_part("id_token", '.', 2)) + 3) / 4) * 4,
          '='
        ),
        'base64'
      ),
      'UTF8'
    )::jsonb AS "claims"
  FROM "accounts"
  WHERE "provider_id" = 'microsoft'
    AND "id_token" ~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$'
)
UPDATE "accounts" AS a
SET "account_id" = t."claims"->>'oid', "updated_at" = now()
FROM tokens AS t
WHERE a."id" = t."id"
  AND t."claims"->>'sub' = t."account_id"
  AND t."claims"->>'oid' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Rows still keyed by something other than a GUID had no usable ID token;
-- they need the oid from a Microsoft Entra export.
DO $$
DECLARE
  remaining integer;
BEGIN
  SELECT count(*) INTO remaining
  FROM "accounts"
  WHERE "provider_id" = 'microsoft'
    AND "account_id" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  IF remaining > 0 THEN
    RAISE WARNING '% microsoft account(s) still keyed by sub: map them to oid from an Entra export', remaining;
  END IF;
END $$;

COMMIT;
