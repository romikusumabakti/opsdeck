SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE INDEX "issues_created_at_idx" ON "issues" ("created_at" DESC NULLS LAST);
