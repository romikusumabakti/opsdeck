-- Fase 3: QA test runs. Additive — a run kind enum and an optional issue link on
-- runs. Existing rows get kind = NULL (unrecorded). Safe while running.
BEGIN;

CREATE TYPE "run_kind" AS ENUM ('backup', 'restore', 'mock_time', 'test');

ALTER TABLE "runs"
	ADD COLUMN "kind" "run_kind",
	ADD COLUMN "issue_id" uuid;

ALTER TABLE "runs"
	ADD CONSTRAINT "runs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE set null;

CREATE INDEX "runs_issue_idx" ON "runs" ("issue_id");

COMMIT;
