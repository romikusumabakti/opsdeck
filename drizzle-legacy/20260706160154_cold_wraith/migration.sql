CREATE TABLE "project_access" (
	"user_id" uuid,
	"project_id" uuid,
	"last_accessed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_access_pkey" PRIMARY KEY("user_id","project_id")
);
--> statement-breakpoint
CREATE INDEX "project_access_user_recency_idx" ON "project_access" ("user_id","last_accessed_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "project_access" ADD CONSTRAINT "project_access_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_access" ADD CONSTRAINT "project_access_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;