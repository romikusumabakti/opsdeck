SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TYPE "release_status" AS ENUM('preparing', 'ready', 'failed');--> statement-breakpoint
ALTER TYPE "run_kind" ADD VALUE IF NOT EXISTS 'release';--> statement-breakpoint
CREATE TABLE "releases" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"project_id" uuid NOT NULL,
	"component_key" text NOT NULL,
	"environment_id" uuid,
	"environment_name" text NOT NULL,
	"deployment_id" uuid,
	"branch" text NOT NULL,
	"tag" text NOT NULL,
	"commit_sha" text NOT NULL,
	"version" text NOT NULL,
	"notes" text,
	"status" "release_status" DEFAULT 'preparing'::"release_status" NOT NULL,
	"error" text,
	"object_key" text,
	"file_name" text,
	"size_bytes" bigint,
	"sha256" text,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"ready_at" timestamp
);
--> statement-breakpoint
CREATE UNIQUE INDEX "releases_version_idx" ON "releases" ("project_id","component_key","version") WHERE status <> 'failed';--> statement-breakpoint
CREATE INDEX "releases_project_idx" ON "releases" ("project_id","created_at");--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_component_key_app_components_component_key_fk" FOREIGN KEY ("component_key") REFERENCES "app_components"("component_key") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL;