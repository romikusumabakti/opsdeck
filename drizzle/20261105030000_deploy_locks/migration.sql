BEGIN;

-- Per-environment deploy lock. Additive only: the running build ignores the
-- new table and status value, so this can be applied before it.
--
-- ADD VALUE inside a transaction is allowed since Postgres 12 as long as the
-- new value is not used before COMMIT (PG 18 here). This migration only adds
-- it, never uses it, so it stays atomic and works with
-- `psql -v ON_ERROR_STOP=1`. On a server older than 12 run the ALTER TYPE
-- line on its own, outside the transaction.
ALTER TYPE deployment_status ADD VALUE 'held';

-- A held deployment has no run until the lock is released and it is queued
-- (a superseded held one never gets one). Relaxing the constraint only: the
-- running build always sets run_id.
ALTER TABLE deployments ALTER COLUMN run_id DROP NOT NULL;

-- At most one lock per environment. "locked_by" is nulled when the user is
-- deleted; the lock stays until unlocked or expired. Timestamps are UTC.
CREATE TABLE environment_deploy_locks (
  environment_id uuid PRIMARY KEY REFERENCES environments (id) ON DELETE CASCADE,
  locked_by uuid REFERENCES users (id) ON DELETE SET NULL,
  reason text NOT NULL,
  expires_at timestamp NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

-- FK index: "on delete set null" scans by locker when a user is deleted.
CREATE INDEX environment_deploy_locks_locked_by_idx ON environment_deploy_locks (locked_by);
-- The expiry sweep scans by expiry.
CREATE INDEX environment_deploy_locks_expires_at_idx ON environment_deploy_locks (expires_at);

COMMIT;
