-- Store DB-side timestamps in UTC wall-clock time, like the rest of the app.
--
-- Timestamp columns are `timestamp` (no time zone) holding UTC, which is what
-- drizzle writes from JS Dates. The server default time zone was Asia/Jakarta,
-- so values produced by DB-side now() (column defaults, `set … = now()`) were
-- stored 7 hours ahead. The app now pins its sessions to UTC (lib/db/index.ts);
-- this migration also makes UTC the database default and converts the columns
-- that are ALWAYS written by DB-side now(). Columns with mixed writers (JS on
-- update, DB default on insert) are left alone: their rows can't be told apart.
--
-- Run once. Restart opsdeck-app right after COMMIT so pooled sessions pick up
-- UTC. Asia/Jakarta has no DST, so the conversion is exact.

BEGIN;

ALTER DATABASE dss_panel SET timezone TO 'UTC';

UPDATE builds SET received_at = (received_at AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'UTC';
UPDATE deploy_apps SET created_at = (created_at AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'UTC';
UPDATE deploy_targets SET
  created_at = (created_at AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'UTC',
  updated_at = (updated_at AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'UTC';
UPDATE deployments SET
  created_at = (created_at AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'UTC',
  started_at = (started_at AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'UTC',
  finished_at = (finished_at AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'UTC',
  heartbeat_at = (heartbeat_at AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'UTC',
  script_started_at = (script_started_at AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'UTC';
UPDATE notifications SET created_at = (created_at AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'UTC';
UPDATE environment_access SET last_accessed_at = (last_accessed_at AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'UTC';
UPDATE environment_mailpit SET updated_at = (updated_at AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'UTC';

COMMIT;
