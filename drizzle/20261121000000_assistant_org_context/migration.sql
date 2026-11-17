SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "assistant_org_context" text;
