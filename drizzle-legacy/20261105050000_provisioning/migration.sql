-- Provisioning: database hosts, per-service database placement, server
-- preflight and the steps of a provisioning run. Additive only: new enum
-- values, new tables and nullable columns without defaults (no table
-- rewrite); the running build ignores all of it, so this can be applied
-- before the build that uses it.
--
-- ADD VALUE is first and outside the transaction block on purpose: the new
-- value is used by later code, and Postgres only lets a value added in a
-- transaction be used after COMMIT. IF NOT EXISTS makes a rerun safe.
ALTER TYPE "run_kind" ADD VALUE IF NOT EXISTS 'provision';

BEGIN;
-- Fail fast rather than wait behind a long transaction on servers,
-- environments or environment_services, blocking every query queued behind
-- this one meanwhile; rerun the migration instead.
SET lock_timeout = '5s';

CREATE TYPE database_kind AS ENUM ('shared', 'container', 'external');
CREATE TYPE provisioning_step_kind AS ENUM (
  'prepare_deploy_dir',
  'create_database',
  'deploy'
);
CREATE TYPE provisioning_step_status AS ENUM (
  'pending',
  'running',
  'done',
  'failed'
);

-- A Postgres container on a server that environments can share. The Panel
-- creates a database and role inside it; backup_path is the path inside the
-- container where its backups are written.
CREATE TABLE database_hosts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  server_id uuid NOT NULL REFERENCES servers (id) ON DELETE RESTRICT,
  container_name text NOT NULL,
  backup_path text NOT NULL,
  label text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX database_hosts_server_container_idx
  ON database_hosts (server_id, container_name);
-- FK index: the on delete restrict check scans by server.
CREATE INDEX database_hosts_server_idx ON database_hosts (server_id);

-- Where a db service's database lives. All nullable: existing services keep
-- working unchanged. db_password_variable names the environment variable that
-- holds the role's password (the value is never stored here).
ALTER TABLE environment_services
  ADD COLUMN db_kind database_kind,
  ADD COLUMN database_host_id uuid REFERENCES database_hosts (id) ON DELETE RESTRICT,
  ADD COLUMN db_role text,
  ADD COLUMN db_password_variable text;

-- FK index: the on delete restrict check scans by database host.
CREATE INDEX environment_services_database_host_idx
  ON environment_services (database_host_id);
-- A database name is unique within its host.
CREATE UNIQUE INDEX environment_services_host_db_name_idx
  ON environment_services (database_host_id, db_name)
  WHERE database_host_id IS NOT NULL;

-- The host port the environment's entry point listens on.
ALTER TABLE environments
  ADD COLUMN entry_port integer,
  ADD CONSTRAINT environments_entry_port_range
    CHECK (entry_port BETWEEN 1 AND 65535);

-- Last preflight scan of a server (see lib/provisioning/preflight.ts) and
-- when it ran. Non-secret facts only. Timestamps are UTC.
ALTER TABLE servers
  ADD COLUMN preflight jsonb,
  ADD COLUMN preflight_at timestamp;

-- Ordered steps of an environment's provisioning. params holds non-secret
-- values only; secrets come from the environment's variables at run time.
CREATE TABLE provisioning_steps (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  environment_id uuid NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
  position integer NOT NULL,
  kind provisioning_step_kind NOT NULL,
  params jsonb NOT NULL,
  status provisioning_step_status NOT NULL DEFAULT 'pending',
  last_error text,
  last_run_id uuid REFERENCES runs (id) ON DELETE SET NULL,
  completed_at timestamp,
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX provisioning_steps_environment_position_idx
  ON provisioning_steps (environment_id, position);
-- FK index: "on delete set null" scans by run when a run is deleted.
CREATE INDEX provisioning_steps_last_run_idx ON provisioning_steps (last_run_id);

COMMIT;
