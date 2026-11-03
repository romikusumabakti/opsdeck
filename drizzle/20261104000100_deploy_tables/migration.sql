-- Panel deploy: apps, per-environment targets, CI builds and deployments.
-- Additive (new enums and tables only); the running build ignores them.
--
-- "deploy_apps"."notify_secret" is encrypted at rest by lib/secrets.ts.
-- "deployments_one_running_per_env_idx" is the DB-level guarantee of at most
-- one running deploy per environment ("environment_id" is denormalised from
-- the target for exactly this index).
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'deploy_trigger') THEN
    CREATE TYPE "public"."deploy_trigger" AS ENUM ('auto', 'manual', 'rollback');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'deployment_status') THEN
    CREATE TYPE "public"."deployment_status" AS ENUM
      ('queued', 'running', 'success', 'failed', 'superseded');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "deploy_apps" (
  "app_key" text PRIMARY KEY NOT NULL,
  "bundle_image" text NOT NULL,
  "notify_secret" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "deploy_targets" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "environment_id" uuid NOT NULL,
  "app_key" text NOT NULL,
  "server_id" uuid NOT NULL,
  "source_branch" text NOT NULL,
  "auto_deploy" boolean DEFAULT false NOT NULL,
  "deploy_dir" text NOT NULL,
  "services" text[] NOT NULL,
  "tag_variable" text DEFAULT 'IMAGE_TAG' NOT NULL,
  "pre_start_command" text,
  "health_url" text,
  "health_timeout_seconds" integer DEFAULT 180 NOT NULL,
  "backup_before_deploy" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "deploy_targets_environment_id_environments_id_fk"
    FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "deploy_targets_app_key_deploy_apps_app_key_fk"
    FOREIGN KEY ("app_key") REFERENCES "public"."deploy_apps"("app_key")
    ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "deploy_targets_server_id_servers_id_fk"
    FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id")
    ON DELETE restrict ON UPDATE no action
);

CREATE UNIQUE INDEX IF NOT EXISTS "deploy_targets_environment_app_idx"
  ON "deploy_targets" ("environment_id", "app_key");
CREATE INDEX IF NOT EXISTS "deploy_targets_app_idx"
  ON "deploy_targets" ("app_key");

CREATE TABLE IF NOT EXISTS "builds" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "app_key" text NOT NULL,
  "branch" text NOT NULL,
  "tag" text NOT NULL,
  "commit_sha" text NOT NULL,
  "pipeline_url" text,
  "received_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "builds_app_key_deploy_apps_app_key_fk"
    FOREIGN KEY ("app_key") REFERENCES "public"."deploy_apps"("app_key")
    ON DELETE cascade ON UPDATE no action
);

CREATE UNIQUE INDEX IF NOT EXISTS "builds_app_tag_idx"
  ON "builds" ("app_key", "tag");
CREATE INDEX IF NOT EXISTS "builds_app_branch_received_idx"
  ON "builds" ("app_key", "branch", "received_at" DESC);

CREATE TABLE IF NOT EXISTS "deployments" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "target_id" uuid NOT NULL,
  "environment_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "tag" text NOT NULL,
  "trigger" "deploy_trigger" NOT NULL,
  "status" "deployment_status" DEFAULT 'queued' NOT NULL,
  "build_id" uuid,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "started_at" timestamp,
  "heartbeat_at" timestamp,
  "finished_at" timestamp,
  CONSTRAINT "deployments_target_id_deploy_targets_id_fk"
    FOREIGN KEY ("target_id") REFERENCES "public"."deploy_targets"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "deployments_environment_id_environments_id_fk"
    FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "deployments_run_id_runs_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "deployments_build_id_builds_id_fk"
    FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id")
    ON DELETE set null ON UPDATE no action
);

CREATE INDEX IF NOT EXISTS "deployments_target_created_idx"
  ON "deployments" ("target_id", "created_at" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS "deployments_one_running_per_env_idx"
  ON "deployments" ("environment_id") WHERE "status" = 'running';

COMMIT;
