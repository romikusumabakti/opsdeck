-- Split the old single-level "projects" table into a two-level model:
--   projects (logical application)  1───*  environments (concrete deployment)
--
-- The old `projects` rows were really deployments, so that table is RENAMED to
-- `environments`; a new `projects` parent is created and each environment is
-- linked to it via a curated backfill (17 rows -> 8 projects). `runs` and
-- `project_access` keep pointing at what is now `environments` (a run/open acts
-- on one deployment); `knowledge_documents` is repointed to the logical project.
-- Adds the per-project `issues` tracker enabled by the new parent.
--
-- Hand-authored: drizzle-kit cannot generate a table rename + data backfill.
-- Transactional and non-destructive (no DROP TABLE / no data loss). Run once.
BEGIN;

-- 1. Old `projects` rows are deployments -> rename the table to `environments`.
--    FKs from runs/project_access/knowledge_documents follow the rename by OID.
ALTER TABLE "projects" RENAME TO "environments";
ALTER TABLE "environments" RENAME CONSTRAINT "projects_pkey" TO "environments_pkey";
ALTER INDEX "projects_db_server_idx" RENAME TO "environments_db_server_idx";
ALTER INDEX "projects_backend_server_idx" RENAME TO "environments_backend_server_idx";
ALTER INDEX "projects_frontend_server_idx" RENAME TO "environments_frontend_server_idx";

-- 2. New logical parent.
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"key" text NOT NULL,
	"client" text,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "projects_key_unique" UNIQUE("key")
);

-- 3. Add the parent FK column, nullable for now so the backfill can populate it.
ALTER TABLE "environments" ADD COLUMN "project_id" uuid;

-- 4. Seed the 8 logical projects.
INSERT INTO "projects" ("name", "key", "client") VALUES
	('Common Membership', 'CMEM', 'DPLK'),
	('Common Portal', 'CPORT', 'DPLK'),
	('Common Portal CMS', 'CPCMS', 'DPLK'),
	('Common Investment', 'CINV', 'DPLK'),
	('CAR Membership', 'CARM', 'CAR'),
	('TMLI Membership', 'TMEM', 'TMLI'),
	('TMLI Portal', 'TPORT', 'TMLI'),
	('Sucor Membership', 'SMEM', 'Sucor');

-- 5. Curated backfill: map each existing environment (by its current name) to a
--    project. "Membership-DevOps" folds into Common Membership as a sandbox env.
WITH mapping("env_name", "key") AS (VALUES
	('CAR Membership Fee Daily (129)', 'CARM'),
	('CAR Membership P2SK (137)', 'CARM'),
	('CAR Membership Release (127)', 'CARM'),
	('Common Investment (132:82)', 'CINV'),
	('Common Membership 1', 'CMEM'),
	('Common Membership (132)', 'CMEM'),
	('Common Membership 2', 'CMEM'),
	('Common Membership 3 (frontend)', 'CMEM'),
	('Common Portal', 'CPORT'),
	('Common Portal (132:81)', 'CPORT'),
	('Common Portal CMS (132:8080)', 'CPCMS'),
	('Membership-DevOps', 'CMEM'),
	('Sucor Membership Demo (138)', 'SMEM'),
	('TMLI Membership Dev (121)', 'TMEM'),
	('TMLI Membership Release (122)', 'TMEM'),
	('TMLI Portal', 'TPORT'),
	('TMLI Portal Release (122:81)', 'TPORT')
)
UPDATE "environments" e
SET "project_id" = p."id"
FROM mapping m
JOIN "projects" p ON p."key" = m."key"
WHERE e."name" = m."env_name";

-- 6. Safety net: fail the transaction if any environment was left unmapped
--    (e.g. a row was renamed since this migration was written).
DO $$
DECLARE unmapped int;
BEGIN
	SELECT count(*) INTO unmapped FROM "environments" WHERE "project_id" IS NULL;
	IF unmapped > 0 THEN
		RAISE EXCEPTION 'Backfill incomplete: % environment(s) have no project_id', unmapped;
	END IF;
END $$;

-- 7. Enforce the link now that it is populated.
ALTER TABLE "environments" ALTER COLUMN "project_id" SET NOT NULL;
ALTER TABLE "environments" ADD CONSTRAINT "environments_project_id_projects_id_fk"
	FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade;
CREATE INDEX "environments_project_idx" ON "environments" ("project_id");
CREATE UNIQUE INDEX "environments_project_name_idx" ON "environments" ("project_id", "name");

-- 8. Repoint knowledge_documents from the deployment to the logical project.
ALTER TABLE "knowledge_documents" DROP CONSTRAINT IF EXISTS "knowledge_documents_project_id_projects_id_fk";
UPDATE "knowledge_documents" d
SET "project_id" = e."project_id"
FROM "environments" e
WHERE d."project_id" = e."id";
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_project_id_projects_id_fk"
	FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE set null;

-- 9. Per-project issue tracker.
CREATE TYPE "public"."issue_status" AS ENUM('open', 'in_progress', 'resolved', 'closed');
CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" "issue_status" DEFAULT 'open' NOT NULL,
	"environment_id" uuid,
	"created_by_id" uuid,
	"assignee_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "issues_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade,
	CONSTRAINT "issues_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE set null,
	CONSTRAINT "issues_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE set null,
	CONSTRAINT "issues_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE set null
);
CREATE UNIQUE INDEX "issues_project_number_idx" ON "issues" ("project_id", "number");
CREATE INDEX "issues_project_status_idx" ON "issues" ("project_id", "status");

COMMIT;
