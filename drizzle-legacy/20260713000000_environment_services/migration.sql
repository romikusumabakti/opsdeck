-- Decompose the wide `environments` "triple" into rows.
--
-- Before: one `environments` row carried a hardcoded db + backend + frontend
-- triple — {server_id, service_type, service_name} × 3 plus db-only columns
-- (db_type/db_name/db_password/db_backup_path) and backend-only columns
-- (mock_time_api_*) flattened onto the parent. That baked a 3-tier monolith
-- into the schema: no room for a worker, cache, gateway, or a 2nd backend, and
-- role-specific columns sat nullable on the parent.
--
-- After: a thin `environments` (identity/purpose only) owns 1..N
-- `environment_services` rows, one per deployable unit, each with its own
-- server + service type + name and the role-specific config it actually needs.
-- The app already thinks in (role → service) terms (lib/services.ts
-- getServiceConfig), so this only moves the storage under that abstraction.
--
-- Hand-authored: drizzle-kit cannot generate the backfill from wide columns to
-- rows. Transactional and non-destructive — the wide columns are copied into
-- `environment_services` BEFORE they are dropped, so no data is lost. This is a
-- breaking schema change: deploy the app together with this migration (Drizzle
-- stops mapping the dropped columns the moment it ships).
BEGIN;

-- 1. Role of a service within its environment. `db`/`backend`/`frontend` match
--    the existing lib/services.ts ServiceRole union; the rest are seeded now so
--    adding a worker/cache/gateway later needs no ALTER TYPE.
CREATE TYPE "service_role" AS ENUM ('db', 'backend', 'frontend', 'worker', 'cache', 'gateway');

-- 2. One row per deployable unit. Role-specific columns are nullable and only
--    populated for the role that uses them (db_* on `db`, mock_time_* on
--    `backend`). server_id keeps onDelete:restrict — a server in use by any
--    service can't be deleted out from under it.
CREATE TABLE "environment_services" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"environment_id" uuid NOT NULL REFERENCES "environments"("id") ON DELETE CASCADE,
	"role" "service_role" NOT NULL,
	"server_id" uuid NOT NULL REFERENCES "servers"("id") ON DELETE RESTRICT,
	"service_type" "service_type" NOT NULL,
	"service_name" text NOT NULL,
	-- db-role config
	"db_type" "database_type",
	"db_name" text,
	"db_password" text,
	"db_backup_path" text,
	-- backend-role config
	"mock_time_api_url" text,
	"mock_time_api_key" text
);

-- 3. Backfill: explode each environment into its three current services. `id`
--    defaults to uuidv7(); the SELECT order matches the INSERT column list.
INSERT INTO "environment_services"
	("environment_id", "role", "server_id", "service_type", "service_name",
	 "db_type", "db_name", "db_password", "db_backup_path")
SELECT "id", 'db', "db_server_id", "db_service_type", "db_service_name",
	 "db_type", "db_name", "db_password", "db_backup_path"
FROM "environments";

INSERT INTO "environment_services"
	("environment_id", "role", "server_id", "service_type", "service_name",
	 "mock_time_api_url", "mock_time_api_key")
SELECT "id", 'backend', "backend_server_id", "backend_service_type", "backend_service_name",
	 "backend_mock_time_api_url", "backend_mock_time_api_key"
FROM "environments";

INSERT INTO "environment_services"
	("environment_id", "role", "server_id", "service_type", "service_name")
SELECT "id", 'frontend', "frontend_server_id", "frontend_service_type", "frontend_service_name"
FROM "environments";

-- 4. Indexes.
--    (environment_id, role) unique: the app resolves exactly one service per
--    role today (getServiceConfig). When multi-instance-per-role is needed,
--    drop this unique and add a per-service slug — a small, separate migration.
CREATE UNIQUE INDEX "environment_services_env_role_idx"
	ON "environment_services" ("environment_id", "role");
--    server usage lookups + the onDelete:restrict check scan by server_id.
CREATE INDEX "environment_services_server_idx"
	ON "environment_services" ("server_id");

-- 5. Drop the now-migrated wide columns and their indexes from `environments`.
--    Dropping a column drops its FK constraint automatically. `environments`
--    keeps: id, project_id, name, slug, kind, owner.
DROP INDEX IF EXISTS "environments_db_server_idx";
DROP INDEX IF EXISTS "environments_backend_server_idx";
DROP INDEX IF EXISTS "environments_frontend_server_idx";

ALTER TABLE "environments"
	DROP COLUMN "db_server_id",
	DROP COLUMN "db_service_type",
	DROP COLUMN "db_service_name",
	DROP COLUMN "db_type",
	DROP COLUMN "db_name",
	DROP COLUMN "db_password",
	DROP COLUMN "db_backup_path",
	DROP COLUMN "backend_server_id",
	DROP COLUMN "backend_service_type",
	DROP COLUMN "backend_service_name",
	DROP COLUMN "backend_mock_time_api_url",
	DROP COLUMN "backend_mock_time_api_key",
	DROP COLUMN "frontend_server_id",
	DROP COLUMN "frontend_service_type",
	DROP COLUMN "frontend_service_name";

COMMIT;
