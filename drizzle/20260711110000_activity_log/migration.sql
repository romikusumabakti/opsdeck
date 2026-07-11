-- Fase 4 (Activity): one append-only org-wide event feed. Additive — a new
-- table only. Safe while running.
BEGIN;

CREATE TABLE "activity_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"data" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "activity_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE set null
);

CREATE INDEX "activity_created_idx" ON "activity_log" ("created_at" DESC);

COMMIT;
