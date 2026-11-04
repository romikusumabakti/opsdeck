BEGIN;

-- Reverse of migration.sql, for use right after a failed rollout, before the
-- app_components / apps data has been edited through the new build.
--
-- Not reversed: the 4 duplicate frontend rows the migration deleted from
-- environment_services (Sucor Investment Dev 1, Dev 2, Demo Local 1, Demo
-- Local 2). Restore the pre-migration dump to get them back. The apps and
-- ci_connections rows are dropped with their tables.

-- Environments: drop the app link.
DROP INDEX "environments_app_idx";
ALTER TABLE environments
  DROP CONSTRAINT "environments_app_id_apps_id_fk",
  DROP COLUMN "app_id";

-- Components: drop the new columns (their constraints and index go with them).
DROP INDEX "app_components_app_idx";
ALTER TABLE app_components
  DROP CONSTRAINT "app_components_app_id_apps_id_fk",
  DROP CONSTRAINT "app_components_ci_connection_id_ci_connections_id_fk",
  DROP COLUMN "app_id",
  DROP COLUMN "ci_connection_id",
  DROP COLUMN "repo_full_name",
  DROP COLUMN "ci_repo_id";

DROP TABLE "apps";
DROP TABLE "ci_connections";
DROP TYPE "public"."forge_kind";
DROP TYPE "public"."ci_provider";

-- component_key -> app_key, app_components -> deploy_apps.
ALTER INDEX deploy_targets_component_idx RENAME TO deploy_targets_app_idx;
ALTER INDEX deploy_targets_environment_component_idx RENAME TO deploy_targets_environment_app_idx;
ALTER TABLE deploy_targets RENAME CONSTRAINT deploy_targets_component_key_app_components_component_key_fk
  TO deploy_targets_app_key_deploy_apps_app_key_fk;
ALTER TABLE deploy_targets RENAME COLUMN component_key TO app_key;

ALTER INDEX builds_component_branch_received_idx RENAME TO builds_app_branch_received_idx;
ALTER INDEX builds_component_tag_idx RENAME TO builds_app_tag_idx;
ALTER TABLE builds RENAME CONSTRAINT builds_component_key_app_components_component_key_fk
  TO builds_app_key_deploy_apps_app_key_fk;
ALTER TABLE builds RENAME COLUMN component_key TO app_key;

ALTER TABLE app_components RENAME CONSTRAINT app_components_pkey TO deploy_apps_pkey;
ALTER TABLE app_components RENAME COLUMN component_key TO app_key;
ALTER TABLE app_components RENAME TO deploy_apps;

COMMIT;
