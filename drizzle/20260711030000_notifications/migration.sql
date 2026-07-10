-- Per-user notification inbox. Text is not stored — only type + JSON data — so
-- each message renders in the recipient's own locale at read time. Additive.
BEGIN;

CREATE TYPE "public"."notification_type" AS ENUM('issue_assigned', 'run_failed');

CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"data" jsonb NOT NULL,
	"href" text,
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);

CREATE INDEX "notifications_user_created_idx" ON "notifications" ("user_id", "created_at" DESC);

COMMIT;
