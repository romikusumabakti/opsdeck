SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TYPE "instance_backup_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "instance_backup_trigger" AS ENUM('schedule', 'manual', 'update');--> statement-breakpoint
CREATE TABLE "instance_backups" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"status" "instance_backup_status" DEFAULT 'running'::"instance_backup_status" NOT NULL,
	"trigger" "instance_backup_trigger" NOT NULL,
	"version" text NOT NULL,
	"location" text NOT NULL,
	"object_key" text,
	"size_bytes" bigint,
	"error_code" text,
	"acknowledged_at" timestamp,
	CONSTRAINT "instance_backups_location_check" CHECK ("location" in ('s3', 'local'))
);
--> statement-breakpoint
CREATE TABLE "instance_settings" (
	"id" integer PRIMARY KEY DEFAULT 1,
	"backup_destination_id" uuid,
	"backup_time" text DEFAULT '02:30' NOT NULL,
	"backup_keep_daily" integer DEFAULT 14 NOT NULL,
	"backup_keep_weekly" integer DEFAULT 8 NOT NULL,
	"secrets_key_fingerprint" text,
	"update_channel" text DEFAULT 'stable' NOT NULL,
	"auto_update" boolean DEFAULT false NOT NULL,
	"auto_update_window" text DEFAULT '03:00' NOT NULL,
	CONSTRAINT "instance_settings_singleton" CHECK ("id" = 1),
	CONSTRAINT "instance_settings_update_channel_check" CHECK ("update_channel" in ('stable', 'beta'))
);
--> statement-breakpoint
CREATE INDEX "instance_backups_started_at_idx" ON "instance_backups" ("started_at");--> statement-breakpoint
ALTER TABLE "instance_settings" ADD CONSTRAINT "instance_settings_backup_destination_id_s3_connections_id_fkey" FOREIGN KEY ("backup_destination_id") REFERENCES "s3_connections"("id") ON DELETE SET NULL;--> statement-breakpoint
INSERT INTO instance_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
