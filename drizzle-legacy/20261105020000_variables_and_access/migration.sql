BEGIN;

-- Environment variables, per-app variable templates and the server placement
-- policy. Additive only: the running build ignores the new tables and columns,
-- so this can be applied before it.
--
-- "environment_variables.value" is encrypted at rest via lib/secrets.ts for the
-- 'secret' and 'generated' kinds; 'plain' values are stored as text.
-- Existing environments keep their hand-managed .env (env_file_managed = false)
-- and existing servers keep today's rule ('restricted').

CREATE TYPE variable_kind AS ENUM ('plain', 'secret', 'generated');
CREATE TYPE server_placement AS ENUM ('restricted', 'open');

ALTER TABLE environments
  ADD COLUMN env_file_managed boolean NOT NULL DEFAULT false;

ALTER TABLE servers
  ADD COLUMN placement server_placement NOT NULL DEFAULT 'restricted';

-- Variables an app expects. "default_value" (plain only) may contain the
-- placeholders {host}, {url} and {envSlug}; "generated_length" (generated only)
-- is the length of the random value.
CREATE TABLE app_variable_templates (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  app_id uuid NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  name text NOT NULL,
  kind variable_kind NOT NULL,
  required boolean NOT NULL DEFAULT false,
  default_value text,
  generated_length integer CHECK (generated_length BETWEEN 16 AND 128),
  escrow boolean NOT NULL DEFAULT false,
  description text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX app_variable_templates_app_name_idx ON app_variable_templates (app_id, name);

-- The values of one environment. Escrowed variables can never be regenerated
-- or deleted through the UI/API.
CREATE TABLE environment_variables (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  environment_id uuid NOT NULL REFERENCES environments (id) ON DELETE CASCADE,
  name text NOT NULL,
  kind variable_kind NOT NULL,
  value text NOT NULL,
  escrow boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX environment_variables_environment_name_idx ON environment_variables (environment_id, name);

-- FK index: "on delete set null" scans by updater when a user is deleted.
CREATE INDEX environment_variables_updated_by_idx ON environment_variables (updated_by);

COMMIT;
