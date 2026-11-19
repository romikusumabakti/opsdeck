SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "assistant_conversations" ADD COLUMN "title_source" text DEFAULT 'first_message' NOT NULL;--> statement-breakpoint
ALTER TABLE "assistant_conversations" ADD COLUMN "pinned_at" timestamp;--> statement-breakpoint
ALTER TABLE "assistant_conversations" ADD COLUMN "temporary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "environment_services" ADD COLUMN "assistant_db_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "environment_services" ADD COLUMN "assistant_db_login" text;--> statement-breakpoint
ALTER TABLE "environment_services" ADD COLUMN "assistant_db_password" text;--> statement-breakpoint
ALTER TABLE "environment_services" ADD COLUMN "assistant_db_enabled_at" timestamp;--> statement-breakpoint
ALTER TABLE "environment_services" ADD COLUMN "assistant_db_enabled_by" uuid;--> statement-breakpoint
CREATE INDEX "assistant_conversations_temporary_updated_idx" ON "assistant_conversations" ("updated_at") WHERE "temporary";--> statement-breakpoint
ALTER TABLE "environment_services" ADD CONSTRAINT "environment_services_assistant_db_enabled_by_fkey" FOREIGN KEY ("assistant_db_enabled_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_title_source_check" CHECK ("title_source" in ('first_message', 'generated', 'user'));--> statement-breakpoint
-- A chat whose title is no longer the one taken from its first question was
-- renamed by its owner: the auto title must never overwrite it. Rerunnable.
UPDATE "assistant_conversations" c SET "title_source" = 'user'
WHERE c."title_source" = 'first_message'
  AND c."title" <> ''
  AND c."title" IS DISTINCT FROM (
    SELECT left(regexp_replace(btrim(m."content", E' \t\n\r\f\v'), '\s+', ' ', 'g'), 80)
    FROM "assistant_messages" m
    WHERE m."conversation_id" = c."id" AND m."role" = 'user'
    ORDER BY m."id"
    LIMIT 1
  );
