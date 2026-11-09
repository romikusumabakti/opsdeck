BEGIN;

-- Who pushed the build behind an auto-deploy. Additive only: nullable columns
-- without defaults (no table rewrite); the running build ignores them, so this
-- can be applied before it.
--
-- Filled best-effort from the CI provider when the build is notified (the
-- pipeline's sender, head commit author email and message); null when the CI
-- API was unavailable or the pipeline URL did not belong to the component's
-- repo. Display only, never used for authorization.
ALTER TABLE builds
  ADD COLUMN pushed_by text,
  ADD COLUMN commit_author_email text,
  ADD COLUMN commit_message text;

-- Free-text actor of a run that has no Panel user: the pusher of the build an
-- auto-deploy came from. A run with user_id keeps showing that user.
ALTER TABLE runs ADD COLUMN triggered_by text;

COMMIT;
