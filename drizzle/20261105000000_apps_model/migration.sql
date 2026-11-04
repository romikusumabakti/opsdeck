BEGIN;

-- Apps model: an app (e.g. the customer portal) groups one or more deployable
-- components, each built by a CI connection from one repository. What used to
-- be a "deploy app" is now a component of an app, so "deploy_apps" is renamed
-- to "app_components" and every "app_key" that pointed at it becomes
-- "component_key". Renames (not recreate + copy) keep rows, encrypted
-- "notify_secret" values and foreign keys intact.
--
-- Not backwards compatible: the running build still reads "deploy_apps".
-- Apply together with the build that reads "app_components".
--
-- The backfill names every live component explicitly; a component it does not
-- know keeps a null "app_id" / "ci_connection_id" and SET NOT NULL aborts the
-- whole migration instead of guessing.

CREATE TYPE "public"."ci_provider" AS ENUM ('woodpecker');
CREATE TYPE "public"."forge_kind" AS ENUM
  ('bitbucket', 'github', 'gitlab', 'gitea', 'forgejo');

CREATE TABLE "ci_connections" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "name" text NOT NULL,
  "provider" "ci_provider" NOT NULL,
  "forge" "forge_kind" NOT NULL,
  "base_url" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "ci_connections_name_unique" UNIQUE ("name")
);

CREATE TABLE "apps" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "app_key" text NOT NULL,
  "name" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "apps_app_key_unique" UNIQUE ("app_key")
);

-- deploy_apps -> app_components, app_key -> component_key.
ALTER TABLE deploy_apps RENAME TO app_components;
ALTER TABLE app_components RENAME COLUMN app_key TO component_key;
ALTER TABLE app_components RENAME CONSTRAINT deploy_apps_pkey TO app_components_pkey;

ALTER TABLE builds RENAME COLUMN app_key TO component_key;
ALTER TABLE builds RENAME CONSTRAINT builds_app_key_deploy_apps_app_key_fk
  TO builds_component_key_app_components_component_key_fk;
ALTER INDEX builds_app_tag_idx RENAME TO builds_component_tag_idx;
ALTER INDEX builds_app_branch_received_idx RENAME TO builds_component_branch_received_idx;

ALTER TABLE deploy_targets RENAME COLUMN app_key TO component_key;
ALTER TABLE deploy_targets RENAME CONSTRAINT deploy_targets_app_key_deploy_apps_app_key_fk
  TO deploy_targets_component_key_app_components_component_key_fk;
ALTER INDEX deploy_targets_environment_app_idx RENAME TO deploy_targets_environment_component_idx;
ALTER INDEX deploy_targets_app_idx RENAME TO deploy_targets_component_idx;

-- New component columns start nullable so they can be backfilled.
ALTER TABLE app_components
  ADD COLUMN "app_id" uuid,
  ADD COLUMN "ci_connection_id" uuid,
  ADD COLUMN "repo_full_name" text,
  ADD COLUMN "ci_repo_id" text,
  ADD CONSTRAINT "app_components_app_id_apps_id_fk"
    FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id")
    ON DELETE restrict ON UPDATE no action,
  ADD CONSTRAINT "app_components_ci_connection_id_ci_connections_id_fk"
    FOREIGN KEY ("ci_connection_id") REFERENCES "public"."ci_connections"("id")
    ON DELETE restrict ON UPDATE no action;
CREATE INDEX "app_components_app_idx" ON "app_components" ("app_id");

-- Backfill (live data 2026-11-04). Woodpecker repo ids are the live ones.
INSERT INTO ci_connections (name, provider, forge, base_url)
VALUES ('Woodpecker – Bitbucket', 'woodpecker', 'bitbucket', 'https://ci.example.net');

INSERT INTO apps (app_key, name) VALUES
  ('dplk-accounting', 'DPLK Accounting'),
  ('dplk-cms', 'DPLK Customer Portal CMS'),
  ('dplk-customer-portal', 'DPLK Customer Portal'),
  ('dplk-membership', 'DPLK Membership'),
  ('hris', 'HRIS'),
  ('dplk-investment', 'DPLK Investment');

-- One explicit row per live component. Only listed components get an app and
-- a CI connection, so an unlisted one trips the SET NOT NULL guards below.
UPDATE app_components c SET
  app_id = a.id,
  ci_connection_id = ci.id,
  repo_full_name = v.repo_full_name,
  ci_repo_id = v.ci_repo_id
FROM (VALUES
  ('dplk-accounting', 'dplk-accounting', 'dss-consulting/dplk-accounting', '1'),
  ('dplk-cms', 'dplk-cms', 'dss-consulting/dplk-customer-portal-cms', '2'),
  ('dplk-customer-portal-backend', 'dplk-customer-portal', 'dss-consulting/dplk-customer-portal-backend', '3'),
  ('dplk-customer-portal-frontend', 'dplk-customer-portal', 'dss-consulting/customer-portal', '4'),
  ('dplk-membership', 'dplk-membership', 'dss-consulting/dplk-membership', '5'),
  ('hris', 'hris', 'dss-consulting/hris', '6'),
  ('dplk-investment', 'dplk-investment', 'dss-consulting/investment', '7')
) AS v (component_key, app_key, repo_full_name, ci_repo_id)
JOIN apps a ON a.app_key = v.app_key
CROSS JOIN ci_connections ci
WHERE ci.name = 'Woodpecker – Bitbucket'
  AND c.component_key = v.component_key;

ALTER TABLE app_components ALTER COLUMN app_id SET NOT NULL;
ALTER TABLE app_components ALTER COLUMN ci_connection_id SET NOT NULL;
ALTER TABLE app_components ALTER COLUMN repo_full_name SET NOT NULL;

-- An environment deploys one app. Environments without deploy targets keep a
-- null app_id until someone assigns one.
ALTER TABLE environments
  ADD COLUMN "app_id" uuid,
  ADD CONSTRAINT "environments_app_id_apps_id_fk"
    FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id")
    ON DELETE restrict ON UPDATE no action;
CREATE INDEX "environments_app_idx" ON "environments" ("app_id");

UPDATE environments e SET app_id = single.app_id
FROM (
  SELECT t.environment_id, (array_agg(DISTINCT c.app_id))[1] AS app_id
  FROM deploy_targets t
  JOIN app_components c ON c.component_key = t.component_key
  GROUP BY t.environment_id
  HAVING count(DISTINCT c.app_id) = 1
) single
WHERE e.id = single.environment_id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM deploy_targets t
    JOIN app_components c ON c.component_key = t.component_key
    GROUP BY t.environment_id
    HAVING count(DISTINCT c.app_id) > 1
  ) THEN
    RAISE EXCEPTION 'an environment has deploy targets of more than one app; split it before migrating';
  END IF;
END
$$;

-- The Kestrel Investment environments created 2026-11-04 recorded the single
-- investment container twice, as backend and as frontend. Keep the backend.
DELETE FROM environment_services f
USING environment_services b
WHERE f.role = 'frontend' AND b.role = 'backend'
  AND f.environment_id = b.environment_id
  AND f.server_id = b.server_id
  AND f.service_name = b.service_name;

COMMIT;
