-- Jira integration.
--
-- Two new tables (a workspace-level Jira site credential, and the binding from
-- an OpsDeck project to a Jira project) plus mirror columns on `issues`,
-- `issue_comments`, and `users`.
--
-- Fully additive: every new column is nullable or defaulted, and no existing
-- column changes type. Safe to apply while the app is running, and safe to
-- re-run (every statement is IF NOT EXISTS / guarded).

-- Which Jira deployment a connection points at — decides Basic vs Bearer auth.
DO $$ BEGIN
  CREATE TYPE "jira_flavor" AS ENUM ('cloud', 'datacenter');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Outcome of the last sweep. `partial` = some issues applied, some failed.
DO $$ BEGIN
  CREATE TYPE "jira_sync_status" AS ENUM ('ok', 'partial', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "jira_connections" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "name" text NOT NULL,
  "base_url" text NOT NULL,
  "flavor" "jira_flavor" NOT NULL DEFAULT 'cloud',
  -- NULL for datacenter: a PAT is a bearer token with no paired username.
  "email" text,
  -- Encrypted at rest (lib/secrets.ts `enc:v1:` envelope).
  "api_token" text NOT NULL,
  -- Random token embedded in the webhook URL path; compared in constant time.
  "webhook_secret" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "jira_project_links" (
  -- One Jira project per OpsDeck project, so the FK is also the primary key.
  "project_id" uuid PRIMARY KEY REFERENCES "projects"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL REFERENCES "jira_connections"("id") ON DELETE CASCADE,
  "jira_project_key" text NOT NULL,
  "jql_filter" text,
  "enabled" boolean NOT NULL DEFAULT true,
  "push_enabled" boolean NOT NULL DEFAULT false,
  "mapping_overrides" jsonb,
  "last_sync_at" timestamp,
  "last_sync_status" "jira_sync_status",
  "last_sync_error" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

-- Two OpsDeck projects mirroring one Jira project would fight over the same
-- remote issues, which are globally unique by jira_issue_id.
CREATE UNIQUE INDEX IF NOT EXISTS "jira_links_connection_key_idx"
  ON "jira_project_links" ("connection_id", "jira_project_key");
CREATE INDEX IF NOT EXISTS "jira_links_connection_idx"
  ON "jira_project_links" ("connection_id");

-- Mirror columns. jira_issue_id (Jira's numeric id) is the join key — jira_key
-- is display only, because a key changes when an issue moves project.
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "jira_issue_id" text;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "jira_key" text;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "jira_updated_at" timestamp;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "jira_synced_at" timestamp;

-- Partial: unlinked issues are the majority and must not collide on NULL.
CREATE UNIQUE INDEX IF NOT EXISTS "issues_jira_issue_id_idx"
  ON "issues" ("jira_issue_id") WHERE "jira_issue_id" IS NOT NULL;

ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "jira_comment_id" text;
CREATE UNIQUE INDEX IF NOT EXISTS "issue_comments_jira_id_idx"
  ON "issue_comments" ("jira_comment_id") WHERE "jira_comment_id" IS NOT NULL;

-- Not unique: a stale duplicate must never block a user row from saving.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "jira_account_id" text;
