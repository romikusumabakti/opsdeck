SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TYPE "assistant_draft_kind" AS ENUM('brd', 'jira');--> statement-breakpoint
CREATE TYPE "assistant_message_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "assistant_message_status" AS ENUM('queued', 'streaming', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "assistant_conversations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid,
	"environment_name" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_drafts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"conversation_id" uuid NOT NULL,
	"kind" "assistant_draft_kind" NOT NULL,
	"content" jsonb NOT NULL,
	"issue_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"conversation_id" uuid NOT NULL,
	"role" "assistant_message_role" NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"status" "assistant_message_status" NOT NULL,
	"error_code" text,
	"sources" jsonb,
	"attachment_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "assistant_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"message_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"input" jsonb NOT NULL,
	"result_meta" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_usage" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"message_id" uuid,
	"user_id" uuid NOT NULL,
	"model" text,
	"input_tokens" integer,
	"cache_read_tokens" integer,
	"cache_write_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(10,6) NOT NULL,
	"day" date NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "assistant_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "anthropic_api_key" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "assistant_model" text DEFAULT 'claude-opus-5-5' NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "assistant_effort" text DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "assistant_daily_cap_usd" numeric(8,2) DEFAULT '1.50' NOT NULL;--> statement-breakpoint
CREATE INDEX "assistant_conversations_user_updated_idx" ON "assistant_conversations" ("user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "assistant_drafts_conversation_idx" ON "assistant_drafts" ("conversation_id");--> statement-breakpoint
CREATE INDEX "assistant_messages_conversation_idx" ON "assistant_messages" ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "assistant_tool_calls_message_idx" ON "assistant_tool_calls" ("message_id");--> statement-breakpoint
CREATE INDEX "assistant_usage_user_day_idx" ON "assistant_usage" ("user_id","day");--> statement-breakpoint
ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "assistant_drafts" ADD CONSTRAINT "assistant_drafts_conversation_id_assistant_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "assistant_conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assistant_drafts" ADD CONSTRAINT "assistant_drafts_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_conversation_id_conversations_fk" FOREIGN KEY ("conversation_id") REFERENCES "assistant_conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assistant_tool_calls" ADD CONSTRAINT "assistant_tool_calls_message_id_assistant_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "assistant_messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assistant_usage" ADD CONSTRAINT "assistant_usage_message_id_assistant_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "assistant_messages"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "assistant_usage" ADD CONSTRAINT "assistant_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;