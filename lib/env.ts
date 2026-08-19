import "server-only";

import { z } from "zod";

/**
 * Startup validation for the process environment.
 *
 * Before this existed, every consumer checked its own vars lazily at first use:
 * `lib/db` threw on the first query, `lib/secrets` on the first decrypt,
 * `lib/storage` and `lib/imgproxy` each carried their own copy of an `env()`
 * helper, and `lib/auth` guarded two vars at module load. The failure mode was
 * a container that booted green and then died inside a background job — a
 * restore, at 3am — because `SECRETS_KEY` was a placeholder.
 *
 * `validateEnv()` is called once from `instrumentation.ts`, so a misconfigured
 * deployment fails at boot with every problem listed at once instead of the
 * first one someone happens to hit.
 *
 * Two kinds of finding:
 *   - ERROR: the app cannot work, or a feature is HALF configured (which is
 *     worse than off — see the Microsoft tenant note below). Throws.
 *   - WARN: an optional feature is entirely unconfigured. Logged once; the app
 *     boots and that feature stays unavailable, which is a supported state
 *     (see .env.example — S3 credentials are deliberately filled in after the
 *     first `docker compose up`).
 *
 * Values are NOT re-exported as a parsed config object. Modules keep reading
 * `process.env` where they need it — a frozen snapshot would be a second source
 * of truth, and the point here is the check, not the plumbing.
 */

// Shared accessor for values that are only required once a feature is actually
// used. Replaces the two identical private `env()` helpers that lib/storage.ts
// and lib/imgproxy.ts each had.
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

// --- Field schemas ---------------------------------------------------------

const postgresUrlSchema = z
  .string()
  .min(1)
  .refine(
    (v) => v.startsWith("postgres://") || v.startsWith("postgresql://"),
    "must be a postgres:// or postgresql:// connection string"
  );

// Mirrors the check in lib/secrets.ts::masterKey. Hoisted to boot so a
// placeholder value is caught before it can strand a job mid-restore.
const base64Key32Schema = z
  .string()
  .min(1)
  .refine((v) => {
    try {
      return Buffer.from(v, "base64").length === 32;
    } catch {
      return false;
    }
  }, "must decode to exactly 32 bytes — generate with: openssl rand -base64 32");

// imgproxy reads these as hex (see lib/imgproxy.ts). Node's `Buffer.from(s,
// "hex")` does not throw on non-hex input, it silently truncates — so a
// leftover `CHANGE_ME` produces an empty key, a signature imgproxy rejects, and
// broken images with no error anywhere. Catch the shape here instead.
const hexSecretSchema = z
  .string()
  .regex(/^[0-9a-fA-F]+$/, "must be hex — generate with: openssl rand -hex 32")
  .refine((v) => v.length % 2 === 0, "must have an even number of hex digits");

const urlSchema = z.url();

const timezoneSchema = z.string().refine((v) => {
  try {
    // Throws RangeError on an unknown IANA zone.
    new Intl.DateTimeFormat("en", { timeZone: v });
    return true;
  } catch {
    return false;
  }
}, "must be a valid IANA timezone name (e.g. Asia/Jakarta)");

const portSchema = z.string().refine((v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65_536;
}, "must be a TCP port number (1-65535)");

// The path Caddy routes to the terminal sidecar. Must start with a slash and
// carry no scheme or host — the client derives ws:// or wss:// from the page.
const wsPathSchema = z
  .string()
  .regex(/^\/[\w\-/]*$/, "must be an absolute path, e.g. /ws/terminal");

// --- Group definitions -----------------------------------------------------

type Finding = { level: "error" | "warn"; message: string };

/** Validate one optional var, when set. */
function checkOptional(
  name: string,
  schema: z.ZodType<string>,
  findings: Finding[]
): void {
  const raw = process.env[name];
  if (!raw) return;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    findings.push({
      level: "error",
      message: `${name}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    });
  }
}

/** Validate one required var. */
function checkRequired(
  name: string,
  schema: z.ZodType<string>,
  findings: Finding[]
): void {
  const raw = process.env[name];
  if (!raw) {
    findings.push({ level: "error", message: `${name} is required but unset` });
    return;
  }
  checkOptional(name, schema, findings);
}

/**
 * An all-or-nothing feature group. None set → the feature is off (warn). All
 * set → validate each. Some set → error, because a partial configuration is a
 * feature that looks enabled and fails at the point of use.
 */
function checkGroup(
  label: string,
  vars: Record<string, z.ZodType<string>>,
  findings: Finding[]
): void {
  const names = Object.keys(vars);
  const present = names.filter((n) => Boolean(process.env[n]));
  if (present.length === 0) {
    findings.push({
      level: "warn",
      message: `${label} is not configured (${names.join(", ")} unset) — that feature is unavailable`,
    });
    return;
  }
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length > 0) {
    findings.push({
      level: "error",
      message: `${label} is partially configured — missing ${missing.join(", ")}. Set all of ${names.join(", ")}, or none.`,
    });
    return;
  }
  for (const [name, schema] of Object.entries(vars)) {
    checkOptional(name, schema, findings);
  }
}

/**
 * Whether "Sign in with Microsoft" is wired up. Read this on the server (e.g.
 * the sign-in page) and pass it down — the credentials are server-only, so
 * there is no `NEXT_PUBLIC_` flag to check on the client.
 *
 * A tenant id is mandatory, not optional: without it better-auth falls back to
 * the "common" authority, which accepts ANY Microsoft account — and because we
 * treat Microsoft as a trusted provider for account linking, a stranger whose
 * personal Microsoft account happens to carry an invited user's email address
 * could then link to (and sign in as) that user. So the group check above
 * turns "two of three set" into a boot error rather than a silent downgrade.
 */
export const MICROSOFT_AUTH_ENABLED = Boolean(
  process.env.MICROSOFT_CLIENT_ID &&
    process.env.MICROSOFT_CLIENT_SECRET &&
    process.env.MICROSOFT_TENANT_ID
);

function collectFindings(): Finding[] {
  const findings: Finding[] = [];

  // Core — nothing works without these.
  checkRequired("DATABASE_URL", postgresUrlSchema, findings);
  checkRequired("SECRETS_KEY", base64Key32Schema, findings);

  // Auth. The secret is only enforced in production: `next dev` and `bun test`
  // let better-auth fall back to an ephemeral one, which is fine for a local
  // session but would silently invalidate every session on each restart (and
  // weaken token signing) if it reached a deployment.
  //
  // Length only, not a base64/32-byte shape: better-auth accepts any string as
  // the signing secret, and tightening that here would lock out a deployment
  // whose existing secret was generated some other way — rotating it logs
  // everyone out.
  if (process.env.NODE_ENV === "production") {
    checkRequired(
      "BETTER_AUTH_SECRET",
      z.string().min(16, "must be at least 16 characters"),
      findings
    );
  }
  // Defaults to http://localhost:3000 in lib/auth when unset, but a malformed
  // value is fatal there — `new URL()` derives the passkey Relying Party ID and
  // origin from it.
  checkOptional("BETTER_AUTH_URL", urlSchema, findings);

  checkOptional("APP_TIMEZONE", timezoneSchema, findings);

  // Terminal sidecar. Both have working defaults (3001 and /ws/terminal), so a
  // deployment that never touches them is fine — a malformed override is not.
  checkOptional("TERMINAL_WS_PORT", portSchema, findings);
  checkOptional("NEXT_PUBLIC_TERMINAL_WS_PATH", wsPathSchema, findings);

  checkGroup(
    "Microsoft sign-in",
    {
      MICROSOFT_CLIENT_ID: z.string().min(1),
      MICROSOFT_CLIENT_SECRET: z.string().min(1),
      MICROSOFT_TENANT_ID: z.string().min(1),
    },
    findings
  );

  // Object storage for knowledge-base attachments. S3_REGION has a default in
  // lib/storage.ts, so it is not part of the group.
  checkGroup(
    "Object storage (S3/Garage)",
    {
      S3_ENDPOINT: urlSchema,
      S3_BUCKET: z.string().min(1),
      S3_ACCESS_KEY: z.string().min(1),
      S3_SECRET_KEY: z.string().min(1),
    },
    findings
  );

  checkGroup(
    "Image processing (imgproxy)",
    {
      IMGPROXY_URL: urlSchema,
      IMGPROXY_KEY: hexSecretSchema,
      IMGPROXY_SALT: hexSecretSchema,
    },
    findings
  );

  // Email is optional by design — invitations and password resets simply fail
  // to send without it. EMAIL_FROM has a branding-derived default.
  if (!process.env.RESEND_API_KEY) {
    findings.push({
      level: "warn",
      message:
        "Email (Resend) is not configured (RESEND_API_KEY unset) — invitations and password resets cannot be sent",
    });
  }

  // The in-process worker already warns and no-ops without this; repeat it here
  // so the whole picture is in one place at boot.
  if (!process.env.REDIS_URL) {
    findings.push({
      level: "warn",
      message:
        "Background jobs are not configured (REDIS_URL unset) — backups, restores, service control and Jira sync will not run",
    });
  } else {
    checkOptional("REDIS_URL", z.string().min(1), findings);
  }

  return findings;
}

/**
 * Check the environment and fail the process on anything fatal.
 *
 * Called from `instrumentation.ts`. Skipped during `next build`: page-data
 * collection evaluates route modules with NODE_ENV=production and no runtime
 * env, and none of these values are needed to emit a bundle.
 */
export function validateEnv(): void {
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const findings = collectFindings();
  const errors = findings.filter((f) => f.level === "error");
  const warnings = findings.filter((f) => f.level === "warn");

  for (const warning of warnings) {
    console.warn(`[env] ${warning.message}`);
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n${errors
        .map((e) => `  - ${e.message}`)
        .join("\n")}\nSee .env.example for the expected values.`
    );
  }
}
