SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "assistant_files" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"user_id" uuid NOT NULL,
	"conversation_id" uuid,
	"message_id" uuid,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"media_type" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "preferred_name" text;--> statement-breakpoint
CREATE INDEX "assistant_files_user_created_idx" ON "assistant_files" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "assistant_files_conversation_idx" ON "assistant_files" ("conversation_id");--> statement-breakpoint
CREATE INDEX "assistant_files_message_idx" ON "assistant_files" ("message_id");--> statement-breakpoint
ALTER TABLE "assistant_files" ADD CONSTRAINT "assistant_files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assistant_files" ADD CONSTRAINT "assistant_files_conversation_id_assistant_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "assistant_conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assistant_files" ADD CONSTRAINT "assistant_files_message_id_assistant_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "assistant_messages"("id") ON DELETE CASCADE;