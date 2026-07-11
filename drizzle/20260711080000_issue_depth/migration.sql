-- Fase 1: issue depth. Additive — new enums, columns (all with defaults or
-- nullable), and two tables. Existing issues become type='task',
-- priority='medium'. Safe to apply while the app is running.
BEGIN;

CREATE TYPE "issue_type" AS ENUM ('bug', 'task', 'story', 'epic');
CREATE TYPE "issue_priority" AS ENUM ('low', 'medium', 'high', 'urgent');

CREATE TABLE "milestones" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"due_at" timestamp,
	"closed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "milestones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade
);
CREATE INDEX "milestones_project_idx" ON "milestones" ("project_id");

ALTER TABLE "issues"
	ADD COLUMN "type" "issue_type" DEFAULT 'task' NOT NULL,
	ADD COLUMN "priority" "issue_priority" DEFAULT 'medium' NOT NULL,
	ADD COLUMN "estimate" integer,
	ADD COLUMN "parent_id" uuid,
	ADD COLUMN "milestone_id" uuid;

ALTER TABLE "issues"
	ADD CONSTRAINT "issues_parent_id_issues_id_fk" FOREIGN KEY ("parent_id") REFERENCES "issues"("id") ON DELETE set null,
	ADD CONSTRAINT "issues_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "milestones"("id") ON DELETE set null;

CREATE INDEX "issues_parent_idx" ON "issues" ("parent_id");
CREATE INDEX "issues_milestone_idx" ON "issues" ("milestone_id");

CREATE TABLE "issue_attachments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"issue_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "issue_attachments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE cascade,
	CONSTRAINT "issue_attachments_uploaded_by_id_users_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE set null
);
CREATE INDEX "issue_attachments_issue_idx" ON "issue_attachments" ("issue_id");

COMMIT;
