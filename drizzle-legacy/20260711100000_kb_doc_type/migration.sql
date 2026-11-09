-- Fase 4 (BA): a document type on knowledge docs so specs/requirements read
-- distinctly from plain notes. Additive — existing docs become 'doc'. Safe while
-- running.
BEGIN;

CREATE TYPE "knowledge_doc_type" AS ENUM ('doc', 'runbook', 'spec', 'requirement');

ALTER TABLE "knowledge_documents"
	ADD COLUMN "doc_type" "knowledge_doc_type" DEFAULT 'doc' NOT NULL;

COMMIT;
