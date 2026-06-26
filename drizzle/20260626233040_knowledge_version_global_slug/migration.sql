ALTER TABLE "knowledge_documents" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DROP INDEX "knowledge_documents_collection_slug_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_documents_slug_idx" ON "knowledge_documents" ("slug");
