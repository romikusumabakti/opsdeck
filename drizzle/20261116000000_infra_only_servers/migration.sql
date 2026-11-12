SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "infra_only" boolean DEFAULT false NOT NULL;
