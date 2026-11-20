SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD COLUMN "parts" jsonb;--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD COLUMN "active_stream_id" text;
