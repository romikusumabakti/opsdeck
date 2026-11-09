CREATE TABLE "knowledge_attachments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"document_id" uuid,
	"storage_key" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "knowledge_attachments_document_idx" ON "knowledge_attachments" ("document_id");--> statement-breakpoint
ALTER TABLE "knowledge_attachments" ADD CONSTRAINT "knowledge_attachments_document_id_knowledge_documents_id_fkey" FOREIGN KEY ("document_id") REFERENCES "knowledge_documents"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "knowledge_attachments" ADD CONSTRAINT "knowledge_attachments_uploaded_by_id_users_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL;