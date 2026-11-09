SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TYPE "environment_archive_location" AS ENUM('local', 's3');--> statement-breakpoint
CREATE TYPE "teardown_step_kind" AS ENUM('check_stack', 'archive_database', 'archive_deploy_dir', 'archive_volumes', 'stack_down', 'drop_database', 'remove_tunnel_route', 'remove_access_app', 'remove_dns_record', 'remove_deploy_dir', 'delete_environment');--> statement-breakpoint
CREATE TYPE "teardown_step_status" AS ENUM('pending', 'running', 'done', 'failed');--> statement-breakpoint
ALTER TYPE "run_kind" ADD VALUE IF NOT EXISTS 'teardown';--> statement-breakpoint
CREATE TABLE "environment_archives" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"environment_id" uuid,
	"project_name" text NOT NULL,
	"environment_name" text NOT NULL,
	"environment_slug" text NOT NULL,
	"deleted_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"location" "environment_archive_location" NOT NULL,
	"key_prefix" text NOT NULL,
	"files" jsonb DEFAULT '[]' NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "teardown_steps" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"environment_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" "teardown_step_kind" NOT NULL,
	"params" jsonb NOT NULL,
	"status" "teardown_step_status" DEFAULT 'pending'::"teardown_step_status" NOT NULL,
	"last_error" text,
	"last_run_id" uuid,
	"completed_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "environment_archives_environment_idx" ON "environment_archives" ("environment_id");--> statement-breakpoint
CREATE INDEX "environment_archives_expires_at_idx" ON "environment_archives" ("expires_at");--> statement-breakpoint
CREATE INDEX "environment_archives_deleted_by_idx" ON "environment_archives" ("deleted_by");--> statement-breakpoint
CREATE UNIQUE INDEX "teardown_steps_environment_position_idx" ON "teardown_steps" ("environment_id","position");--> statement-breakpoint
CREATE INDEX "teardown_steps_last_run_idx" ON "teardown_steps" ("last_run_id");--> statement-breakpoint
ALTER TABLE "environment_archives" ADD CONSTRAINT "environment_archives_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "teardown_steps" ADD CONSTRAINT "teardown_steps_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "teardown_steps" ADD CONSTRAINT "teardown_steps_last_run_id_fkey" FOREIGN KEY ("last_run_id") REFERENCES "runs"("id") ON DELETE SET NULL;