SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD COLUMN "environment_name" text;--> statement-breakpoint
ALTER TABLE "assistant_usage" ADD COLUMN "estimated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "assistant_provider" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "assistant_api_key" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "assistant_base_url" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "assistant_price_input" numeric(12,6);--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "assistant_price_output" numeric(12,6);--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "assistant_price_cache_read" numeric(12,6);--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "assistant_price_cache_write" numeric(12,6);--> statement-breakpoint
ALTER TABLE "assistant_conversations" ALTER COLUMN "environment_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_settings" ALTER COLUMN "assistant_model" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "instance_settings" ALTER COLUMN "assistant_model" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD CONSTRAINT "instance_settings_assistant_provider_check" CHECK ("assistant_provider" in ('anthropic', 'openai', 'google', 'openai-compatible'));--> statement-breakpoint
UPDATE "instance_settings" SET
	"assistant_provider" = 'anthropic',
	"assistant_api_key" = "anthropic_api_key",
	"assistant_price_input" = CASE "assistant_model" WHEN 'claude-opus-5-5' THEN 4 ELSE 2 END,
	"assistant_price_output" = CASE "assistant_model" WHEN 'claude-opus-5-5' THEN 20 ELSE 10 END,
	"assistant_price_cache_read" = CASE "assistant_model" WHEN 'claude-opus-5-5' THEN 0.20 ELSE 0.10 END,
	"assistant_price_cache_write" = CASE "assistant_model" WHEN 'claude-opus-5-5' THEN 5 ELSE 2.50 END
WHERE "anthropic_api_key" IS NOT NULL AND "assistant_provider" IS NULL;--> statement-breakpoint
UPDATE "assistant_messages" AS m SET
	"environment_id" = c."environment_id",
	"environment_name" = c."environment_name"
FROM "assistant_conversations" AS c
WHERE m."conversation_id" = c."id" AND m."role" = 'user' AND m."environment_name" IS NULL;
