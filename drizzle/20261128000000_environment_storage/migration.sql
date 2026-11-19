SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "environment_archives" ADD COLUMN "in_backup_destination" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "environment_archives" ADD COLUMN "s3_endpoint" text;--> statement-breakpoint
ALTER TABLE "environment_archives" ADD COLUMN "s3_bucket" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "backup_s3_endpoint" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "backup_s3_region" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "backup_s3_bucket" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "backup_s3_access_key_id" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "backup_s3_secret_key" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "backup_s3_force_path_style" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "backup_s3_key_prefix" text;--> statement-breakpoint
ALTER TABLE "s3_connections" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "s3_connections" ADD COLUMN "key_prefix" text;--> statement-breakpoint
CREATE INDEX "s3_connections_environment_idx" ON "s3_connections" ("environment_id");--> statement-breakpoint
ALTER TABLE "s3_connections" ADD CONSTRAINT "s3_connections_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "environment_archives" ADD CONSTRAINT "environment_archives_backup_destination_check" CHECK (NOT "in_backup_destination" OR ("location" = 's3' AND "s3_connection_id" IS NULL AND "s3_endpoint" IS NOT NULL AND "s3_bucket" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "instance_settings" ADD CONSTRAINT "instance_settings_backup_s3_complete_check" CHECK (num_nonnulls("backup_s3_endpoint", "backup_s3_region", "backup_s3_bucket", "backup_s3_access_key_id", "backup_s3_secret_key") in (0, 5));--> statement-breakpoint
ALTER TABLE "instance_settings" ADD CONSTRAINT "instance_settings_backup_s3_key_prefix_check" CHECK ("backup_s3_key_prefix" IS NULL OR ("backup_s3_key_prefix" <> '' AND left("backup_s3_key_prefix", 1) <> '/' AND right("backup_s3_key_prefix", 1) = '/'));--> statement-breakpoint
ALTER TABLE "s3_connections" ADD CONSTRAINT "s3_connections_key_prefix_check" CHECK ("key_prefix" IS NULL OR ("key_prefix" <> '' AND left("key_prefix", 1) <> '/' AND right("key_prefix", 1) = '/'));
--> statement-breakpoint
-- Backfill: the backup destination gets its own credentials, copied from the
-- S3 connection instance_settings.backup_destination_id points at (secret key
-- copied verbatim: an enc:v1 envelope or legacy plaintext, both of which
-- decryptSecret reads). The connection row stays, unassigned, and
-- backup_destination_id is left as it is so today's readers keep working.
-- Idempotent: only a destination that is not configured yet is filled, so a
-- re-run never overwrites one edited since. No row or no chosen connection
-- (an empty database) updates nothing.
UPDATE "instance_settings" SET
  "backup_s3_endpoint" = c."endpoint",
  "backup_s3_region" = c."region",
  "backup_s3_bucket" = c."bucket",
  "backup_s3_access_key_id" = c."access_key_id",
  "backup_s3_secret_key" = c."secret_key",
  "backup_s3_force_path_style" = c."force_path_style"
FROM "s3_connections" c
WHERE c."id" = "instance_settings"."backup_destination_id"
  AND "instance_settings"."backup_s3_endpoint" IS NULL;
