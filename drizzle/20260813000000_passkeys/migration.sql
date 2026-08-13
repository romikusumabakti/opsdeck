-- Passkeys (WebAuthn credentials).
--
-- One table, owned by the better-auth passkey plugin (@better-auth/passkey).
-- Column names are the plugin's model fields mapped to snake_case; the drizzle
-- adapter binds them by the schema keys in lib/db/schema.ts, so renaming a
-- column here means renaming it there too.
--
-- Fully additive: nothing existing changes, and every statement is guarded, so
-- it is safe to apply while the app is running and safe to re-run.

CREATE TABLE IF NOT EXISTS "passkeys" (
  -- Generated in JS as UUIDv7 by better-auth (see `advanced.database.generateId`
  -- in lib/auth.ts), like the other auth tables — no server-side default.
  "id" uuid PRIMARY KEY,
  -- Human label shown in the account UI. NULL until the plugin or the user
  -- names it; the plugin derives a default from the authenticator's aaguid.
  "name" text,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  -- Base64url credential id and COSE public key from the authenticator.
  "credential_id" text NOT NULL,
  "public_key" text NOT NULL,
  -- Signature counter for clone detection; bumped on each authentication.
  "counter" integer NOT NULL DEFAULT 0,
  -- 'singleDevice' | 'multiDevice' — whether the credential syncs.
  "device_type" text NOT NULL,
  "backed_up" boolean NOT NULL DEFAULT false,
  -- Comma-joined WebAuthn transport hints, e.g. 'internal,hybrid'.
  "transports" text,
  -- Authenticator model id, used only for labeling. Apple and other
  -- privacy-preserving platforms report an all-zero value.
  "aaguid" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);

-- Listing a user's passkeys, and building `excludeCredentials` on registration.
CREATE INDEX IF NOT EXISTS "passkeys_user_idx" ON "passkeys" ("user_id");

-- Sign-in resolves the credential the browser returned before any user is
-- known. Unique because a credential id identifies exactly one credential.
CREATE UNIQUE INDEX IF NOT EXISTS "passkeys_credential_id_idx"
  ON "passkeys" ("credential_id");
