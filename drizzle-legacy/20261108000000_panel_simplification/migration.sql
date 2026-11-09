-- Panel simplification: project roles are renamed to the names people use
-- (contributor -> qa, maintainer -> engineer), a project gets an optional
-- default server, environments lose the display-only host (the URL carries
-- it) and the deprecated free-text owner, and a Cloudflare zone may exist
-- without its own API token. URLs follow environment domains.
--
-- Not additive: the running build still reads the old role names and
-- environments.host, so deploy the new build and apply this migration together.
--
-- Fail fast rather than wait behind a long transaction: ALTER TABLE takes an
-- ACCESS EXCLUSIVE lock, so rerun the migration instead of blocking queued
-- queries.
SET lock_timeout = '5s';

BEGIN;

ALTER TYPE project_role RENAME VALUE 'contributor' TO 'qa';
ALTER TYPE project_role RENAME VALUE 'maintainer' TO 'engineer';

ALTER TABLE projects
  ADD COLUMN default_server_id uuid REFERENCES servers(id) ON DELETE SET NULL;

-- Keep the address people already typed: an environment with a host but no URL
-- gets an http:// URL built from it before the column goes away.
UPDATE environments SET url = 'http://' || host WHERE url IS NULL AND host IS NOT NULL;

-- An environment with a domain opens at that domain's address: the Panel
-- keeps the URL in step with the domain from now on (and Settings shows it
-- read-only), so bring every stored URL in line once.
UPDATE environments e SET url = 'https://' || d.hostname
  FROM environment_domains d
  WHERE d.environment_id = e.id AND e.url IS DISTINCT FROM 'https://' || d.hostname;

ALTER TABLE environments
  DROP COLUMN host,
  DROP COLUMN owner;

ALTER TABLE cloudflare_zones ALTER COLUMN api_token DROP NOT NULL;

COMMIT;
