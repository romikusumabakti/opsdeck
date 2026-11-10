SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TYPE "deploy_target_kind" AS ENUM('compose', 'jar', 'static');--> statement-breakpoint
DROP INDEX "app_components_ci_repo_idx";--> statement-breakpoint
ALTER TABLE "app_components" ADD COLUMN "notify_secret_name" text DEFAULT 'opsdeck_notify' NOT NULL;--> statement-breakpoint
ALTER TABLE "deploy_targets" ADD COLUMN "kind" "deploy_target_kind" DEFAULT 'compose' NOT NULL;--> statement-breakpoint
ALTER TABLE "deploy_targets" ADD COLUMN "jar_name" text;--> statement-breakpoint
ALTER TABLE "deploy_targets" ADD COLUMN "systemd_unit" text;--> statement-breakpoint
CREATE INDEX "app_components_ci_repo_lookup_idx" ON "app_components" ("ci_connection_id","ci_repo_id");--> statement-breakpoint
ALTER TABLE "deploy_targets" ADD CONSTRAINT "deploy_targets_kind_fields_check" CHECK (("kind" = 'jar' and "jar_name" is not null and "systemd_unit" is not null) or ("kind" <> 'jar' and "jar_name" is null and "systemd_unit" is null));