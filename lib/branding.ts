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

export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "Admin Panel";

export const COMPANY_NAME =
  process.env.NEXT_PUBLIC_COMPANY_NAME ?? "the company";

export const ALLOWED_EMAIL_DOMAIN =
  process.env.NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN ?? "example.com";

export const DEFAULT_EMAIL_FROM = `${APP_NAME} <no-reply@${ALLOWED_EMAIL_DOMAIN}>`;

export function isAllowedEmail(email: string): boolean {
  return email.toLowerCase().trim().endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);
}
