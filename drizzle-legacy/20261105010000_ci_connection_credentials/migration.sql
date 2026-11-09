BEGIN;

-- CI connection credentials, pipeline mode and build spec. Additive only: the
-- running build ignores the new columns, so this can be applied before it.
--
-- "api_token" and "forge_token" are encrypted at rest via lib/secrets.ts.
-- Existing components keep their hand-written pipeline ('custom').
-- "pipeline_file_commits" maps each built branch to the last commit of the
-- generated .woodpecker.yaml: {"<branch>": {"sha"?, "error"?, "at"}}.

CREATE TYPE pipeline_mode AS ENUM ('custom', 'generated');

ALTER TABLE ci_connections
  ADD COLUMN api_token text,
  ADD COLUMN forge_username text,
  ADD COLUMN forge_token text;

ALTER TABLE app_components
  ADD COLUMN pipeline_mode pipeline_mode NOT NULL DEFAULT 'custom',
  ADD COLUMN build_spec jsonb,
  ADD COLUMN pipeline_file_commits jsonb;

-- A CI repository builds at most one component (NULLs, i.e. not yet activated,
-- do not collide). The live ids backfilled by the apps model are distinct.
CREATE UNIQUE INDEX app_components_ci_repo_idx ON app_components (ci_connection_id, ci_repo_id);

COMMIT;
