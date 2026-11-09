-- Cloudflare domains: the account-level credential, remotely-managed tunnels
-- registered per server, a public domain per environment, and three new
-- provisioning step kinds. Additive only: new enum values, new enum and new
-- tables; the running build ignores all of it, so this can be applied before
-- the build that uses it.
--
-- Fail fast rather than wait behind a long transaction: ALTER TYPE and the
-- statements below take locks on provisioning_step_kind, servers,
-- environments and cloudflare_zones, so rerun the migration instead of
-- blocking queued queries. A session setting, so it comes first and covers
-- the ADD VALUE statements outside the transaction block too.
SET lock_timeout = '5s';

-- ADD VALUE comes before and outside the transaction block on purpose: the new
-- values are used by later code, and Postgres only lets a value added in a
-- transaction be used after COMMIT. IF NOT EXISTS makes a rerun safe.
ALTER TYPE "provisioning_step_kind" ADD VALUE IF NOT EXISTS 'tunnel_route';
ALTER TYPE "provisioning_step_kind" ADD VALUE IF NOT EXISTS 'access_app';
ALTER TYPE "provisioning_step_kind" ADD VALUE IF NOT EXISTS 'dns_record';

BEGIN;

CREATE TYPE domain_kind AS ENUM ('tunnel', 'external');

-- The Cloudflare account the Panel manages tunnels, Access apps and DNS
-- records in. api_token is encrypted at rest (lib/secrets.ts) and never sent
-- to the client. access_idp_id is the identity provider Access apps allow.
CREATE TABLE cloudflare_accounts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id text NOT NULL UNIQUE,
  name text NOT NULL,
  api_token text NOT NULL,
  access_idp_id text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

-- A remotely-managed tunnel running on a server. One per server.
CREATE TABLE remote_tunnels (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  account_id uuid NOT NULL REFERENCES cloudflare_accounts (id) ON DELETE RESTRICT,
  server_id uuid NOT NULL REFERENCES servers (id) ON DELETE RESTRICT,
  tunnel_id text NOT NULL,
  name text NOT NULL,
  origin_host text NOT NULL DEFAULT 'localhost',
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX remote_tunnels_account_tunnel_idx
  ON remote_tunnels (account_id, tunnel_id);
-- One remote tunnel per server; also serves the server FK restrict check.
CREATE UNIQUE INDEX remote_tunnels_server_idx ON remote_tunnels (server_id);

-- The public domain of an environment: at most one, so the environment is the
-- key. No row means no domain. access_app_id and dns_record_id are written by
-- the provisioning steps.
CREATE TABLE environment_domains (
  environment_id uuid PRIMARY KEY REFERENCES environments (id) ON DELETE CASCADE,
  kind domain_kind NOT NULL,
  hostname text NOT NULL UNIQUE,
  zone_id uuid REFERENCES cloudflare_zones (id) ON DELETE RESTRICT,
  remote_tunnel_id uuid REFERENCES remote_tunnels (id) ON DELETE RESTRICT,
  access_policy_id text,
  access_app_id text,
  dns_record_id text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT environment_domains_tunnel_refs
    CHECK (kind <> 'tunnel' OR (zone_id IS NOT NULL AND remote_tunnel_id IS NOT NULL))
);

-- FK indexes: the on delete restrict checks scan by zone and by tunnel.
CREATE INDEX environment_domains_zone_idx ON environment_domains (zone_id);
CREATE INDEX environment_domains_remote_tunnel_idx
  ON environment_domains (remote_tunnel_id);

COMMIT;
