-- MySQL/MariaDB support for the database feature.
--
-- One enum value covers both engines: they share a wire protocol and a
-- mysqldump format, so splitting them would only duplicate every dbType branch
-- and (because cross-environment restore gates on dbType equality) forbid
-- restoring a MariaDB dump into MySQL, which is legal. The remote command
-- builders probe for the MariaDB-renamed binaries before the mysql* names.
--
-- `db_user` is the admin login for the engines the panel authenticates to over
-- TCP. It exists because the Debian/Ubuntu packages of both MySQL and MariaDB
-- put `root@localhost` on the unix_socket auth plugin, so a hardcoded `root`
-- would fail on the most common install; operators point this at a dedicated
-- account instead. NULL keeps the previous behaviour (engine default: `sa` for
-- mssql, `root` for mysql, `postgres` for postgres), so no backfill is needed.
BEGIN;

-- Safe inside a transaction (Postgres 12+) because nothing below REFERENCES the
-- new label — that is the only thing the engine forbids in the same block.
ALTER TYPE "public"."database_type" ADD VALUE IF NOT EXISTS 'mysql';

ALTER TABLE "environment_services" ADD COLUMN IF NOT EXISTS "db_user" text;

COMMIT;
