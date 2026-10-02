-- Mailpit inbox integration: one optional connection per environment.
--
-- A 1:1 side table instead of columns on "environments": whole environment
-- rows are sent to client components in several places, and a secret column
-- there would end up (encrypted) in RSC payloads. Row present = enabled;
-- deleting the environment deletes its Mailpit connection.
--
-- "password" is encrypted at rest by lib/secrets.ts (`enc:v1:` envelope), the
-- same treatment as servers.password and environment_services.db_password.
BEGIN;

CREATE TABLE IF NOT EXISTS "environment_mailpit" (
  "environment_id" uuid PRIMARY KEY NOT NULL,
  "url" text NOT NULL,
  "username" text,
  "password" text,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "environment_mailpit_environment_id_environments_id_fk"
    FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id")
    ON DELETE cascade ON UPDATE no action
);

COMMIT;
