-- Setup wizard: the Docker network a shared database host is reachable on
-- (so a compose overlay can attach an app to it), and a flag that makes a
-- deploy target deploy the first build of its branch once that build exists.
-- Additive only: two new columns, one nullable and one with a constant
-- default; the running build ignores both, so this can be applied before the
-- build that uses them.
--
-- Fail fast rather than wait behind a long transaction: ALTER TABLE takes an
-- ACCESS EXCLUSIVE lock on database_hosts and deploy_targets, so rerun the
-- migration instead of blocking queued queries.
SET lock_timeout = '5s';

BEGIN;

ALTER TABLE database_hosts
  ADD COLUMN network text,
  ADD CONSTRAINT database_hosts_network_format
    CHECK (network IS NULL OR network ~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$');

ALTER TABLE deploy_targets
  ADD COLUMN deploy_next_build boolean NOT NULL DEFAULT false;

COMMIT;
