SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "ssh_key_jobs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"kind" text NOT NULL,
	"actor_id" uuid,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	"results" jsonb DEFAULT '[]' NOT NULL,
	"error_code" text,
	CONSTRAINT "ssh_key_jobs_kind_check" CHECK ("kind" in ('moveAll', 'rotate'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_key_jobs_one_open_idx" ON "ssh_key_jobs" ((true)) WHERE finished_at is null;--> statement-breakpoint
CREATE INDEX "ssh_key_jobs_requested_at_idx" ON "ssh_key_jobs" ("requested_at");--> statement-breakpoint
ALTER TABLE "ssh_key_jobs" ADD CONSTRAINT "ssh_key_jobs_actor_id_users_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL;