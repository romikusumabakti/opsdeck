/**
 * Whitelabel branding configuration.
 *
 * All deployment-specific identity (app name, company name, email domain)
 * lives here so the codebase stays generic. Values are read from
 * `NEXT_PUBLIC_*` env vars so they're available on both server and client.
 *
 * The fallback defaults are intentionally generic — set the env vars for
 * any real deployment.
 */

export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "OpsDeck";

export const COMPANY_NAME =
  process.env.NEXT_PUBLIC_COMPANY_NAME ?? "the company";

export const ALLOWED_EMAIL_DOMAIN =
  process.env.NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN ?? "example.com";

/**
 * The logo — sidebar, auth pages and favicon. Unlike the env vars above it is a
 * runtime file, not a build-time value: a deployment mounts its own directory
 * over `public/brand` (BRAND_DIR in compose.yaml), so the repo only ships a
 * neutral default.
 */
export const BRAND_LOGO_SRC = "/brand/logo.svg";

export const DEFAULT_EMAIL_FROM = `${APP_NAME} <no-reply@${ALLOWED_EMAIL_DOMAIN}>`;

export function isAllowedEmail(email: string): boolean {
  return email.toLowerCase().trim().endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);
}
