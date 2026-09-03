-- Cloudflare Tunnel subdomain management.
--
-- Two registry tables and nothing else. The routes themselves are NOT stored:
-- a tunnel's `config.yml` on its host stays the single source of truth for its
-- ingress table, and these rows only record where that file is and which
-- credential may publish DNS for it. Mirroring routes here would create a
-- second source of truth for the same fact, and a stale copy is exactly how
-- orphaned hostnames (Cloudflare error 1016) go unnoticed.
--
-- `api_token` is encrypted at rest by lib/secrets.ts (`enc:v1:` envelope), the
-- same treatment as servers.password and jira_connections.api_token. Scope the
-- token to `Zone:DNS:Edit` on the one zone: that is the entire set of calls the
-- panel makes, and it excludes tunnel creation on purpose.
BEGIN;

CREATE TABLE IF NOT EXISTS "cloudflare_zones" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "name" text NOT NULL,
  "zone_id" text NOT NULL,
  "api_token" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "cloudflare_zones_name_unique" UNIQUE("name")
);

CREATE TABLE IF NOT EXISTS "tunnels" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "zone_id" uuid NOT NULL,
  "server_id" uuid NOT NULL,
  "name" text NOT NULL,
  "tunnel_id" text NOT NULL,
  "stack_dir" text NOT NULL,
  "config_path" text DEFAULT 'cloudflared/config.yml' NOT NULL,
  "container_name" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- RESTRICT on both parents: a zone whose credential still publishes hostnames,
-- and a server still hosting a tunnel, must not disappear from under it.
ALTER TABLE "tunnels"
  ADD CONSTRAINT "tunnels_zone_id_cloudflare_zones_id_fk"
  FOREIGN KEY ("zone_id") REFERENCES "public"."cloudflare_zones"("id")
  ON DELETE restrict ON UPDATE no action;

ALTER TABLE "tunnels"
  ADD CONSTRAINT "tunnels_server_id_servers_id_fk"
  FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id")
  ON DELETE restrict ON UPDATE no action;

-- One row per tunnel per host: two rows for the same tunnel would let two stack
-- directories each claim to own its ingress table.
CREATE UNIQUE INDEX IF NOT EXISTS "tunnels_server_tunnel_idx"
  ON "tunnels" ("server_id","tunnel_id");
CREATE INDEX IF NOT EXISTS "tunnels_zone_idx" ON "tunnels" ("zone_id");
CREATE INDEX IF NOT EXISTS "tunnels_server_idx" ON "tunnels" ("server_id");

COMMIT;
