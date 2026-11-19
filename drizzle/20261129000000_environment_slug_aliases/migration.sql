SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "environment_slug_aliases" (
	"project_id" uuid,
	"slug" text,
	"environment_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "environment_slug_aliases_pkey" PRIMARY KEY("project_id","slug")
);
--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "created_slug" text;--> statement-breakpoint
CREATE INDEX "environment_slug_aliases_environment_idx" ON "environment_slug_aliases" ("environment_id");--> statement-breakpoint
ALTER TABLE "environment_slug_aliases" ADD CONSTRAINT "environment_slug_aliases_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "environment_slug_aliases" ADD CONSTRAINT "environment_slug_aliases_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE;--> statement-breakpoint
-- Every existing environment was created with the slug it has now: the alias
-- table above starts empty, so no environment has been renamed yet.
UPDATE "environments" SET "created_slug" = "slug";