-- knowledge_attachments.document_id was never populated: the markdown body is
-- the single source of truth for which asset a document references, so the FK
-- and its index are dead weight. Drop them. (version column + global slug index
-- already landed in 20260626233040; this migration only removes the dead FK.)
ALTER TABLE "knowledge_attachments" DROP CONSTRAINT "knowledge_attachments_document_id_knowledge_documents_id_fkey";--> statement-breakpoint
DROP INDEX "knowledge_attachments_document_idx";--> statement-breakpoint
ALTER TABLE "knowledge_attachments" DROP COLUMN "document_id";
