-- Per-project membership for RBAC (Phase 0). Effective role at any scope is
-- max(users.role global floor, this per-project role). Additive: no existing
-- table is touched, so this is safe to apply while the app is running.
BEGIN;

CREATE TYPE "project_role" AS ENUM ('viewer', 'member', 'maintainer', 'admin');

CREATE TABLE "project_members" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "project_role" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_members_project_id_user_id_pk" PRIMARY KEY ("project_id", "user_id"),
	CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade,
	CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);

CREATE INDEX "project_members_user_idx" ON "project_members" ("user_id");

COMMIT;
