-- Panel deploy: a new run kind for deployments. Additive: the running build
-- never writes this value, so this can be applied before the deploy.
-- Kept in its own migration: the new value can't be used in the same
-- transaction that adds it, and the next migration's tables don't use it.
BEGIN;

ALTER TYPE "run_kind" ADD VALUE IF NOT EXISTS 'deploy';

COMMIT;
