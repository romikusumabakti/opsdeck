CREATE TABLE "knowledge_collections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"name" text NOT NULL,
	"icon" text,
	"description" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"collection_id" uuid NOT NULL,
	"parent_id" uuid,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"content_text" text DEFAULT '' NOT NULL,
	"search_vector" tsvector GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce("knowledge_documents"."title", '')), 'A') || setweight(to_tsvector('simple', coalesce("knowledge_documents"."content_text", '')), 'B')) STORED,
	"position" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp,
	"project_id" uuid,
	"created_by_id" uuid,
	"updated_by_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_links" (
	"from_document_id" uuid,
	"to_document_id" uuid,
	CONSTRAINT "knowledge_links_pkey" PRIMARY KEY("from_document_id","to_document_id")
);
--> statement-breakpoint
CREATE TABLE "knowledge_revisions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"document_id" uuid NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"edited_by_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "knowledge_documents_tree_idx" ON "knowledge_documents" ("collection_id","parent_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_documents_collection_slug_idx" ON "knowledge_documents" ("collection_id","slug");--> statement-breakpoint
CREATE INDEX "knowledge_documents_search_idx" ON "knowledge_documents" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "knowledge_documents_project_idx" ON "knowledge_documents" ("project_id");--> statement-breakpoint
CREATE INDEX "knowledge_links_to_idx" ON "knowledge_links" ("to_document_id");--> statement-breakpoint
CREATE INDEX "knowledge_revisions_document_idx" ON "knowledge_revisions" ("document_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "knowledge_collections" ADD CONSTRAINT "knowledge_collections_created_by_id_users_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_collection_id_knowledge_collections_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "knowledge_collections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_parent_id_knowledge_documents_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "knowledge_documents"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_created_by_id_users_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_updated_by_id_users_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "knowledge_links" ADD CONSTRAINT "knowledge_links_from_document_id_knowledge_documents_id_fkey" FOREIGN KEY ("from_document_id") REFERENCES "knowledge_documents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_links" ADD CONSTRAINT "knowledge_links_to_document_id_knowledge_documents_id_fkey" FOREIGN KEY ("to_document_id") REFERENCES "knowledge_documents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_revisions" ADD CONSTRAINT "knowledge_revisions_document_id_knowledge_documents_id_fkey" FOREIGN KEY ("document_id") REFERENCES "knowledge_documents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge_revisions" ADD CONSTRAINT "knowledge_revisions_edited_by_id_users_id_fkey" FOREIGN KEY ("edited_by_id") REFERENCES "users"("id") ON DELETE SET NULL;