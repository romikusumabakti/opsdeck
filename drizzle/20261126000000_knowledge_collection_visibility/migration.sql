SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "knowledge_collections" ADD COLUMN "visible_to_roles" text[] DEFAULT '{}'::text[] NOT NULL;