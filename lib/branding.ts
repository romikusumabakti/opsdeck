/**
 * Deployment configuration that is not instance branding: the sign-in email
 * domain (ALLOWED_EMAIL_DOMAIN), read from the server env at runtime. The
 * instance name, company, logo and accent live in Admin › Instance › Branding
 * (lib/instance-branding.ts).
 *
 * Server-only: this reads `process.env` at module load. Client code takes the
 * same values from `/api/bootstrap`.
 */

export const ALLOWED_EMAIL_DOMAIN =
  process.env.ALLOWED_EMAIL_DOMAIN || "example.com";

/**
 * The From address when EMAIL_FROM is unset: `<name> <no-reply@domain>`. The
 * name is admin input, so anything beyond letters, digits, spaces and hyphens
 * is sent as an RFC 5322 quoted string, and line breaks are dropped.
 */
export function defaultEmailFrom(name: string): string {
  const flat = name.replace(/[\r\n]+/g, " ").trim();
  const display = /^[\p{L}\p{N} -]*$/u.test(flat)
    ? flat
    : `"${flat.replace(/["\\]/g, "\\$&")}"`;
  return `${display} <no-reply@${ALLOWED_EMAIL_DOMAIN}>`;
}

export function isAllowedEmail(email: string): boolean {
  return email.toLowerCase().trim().endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);
}
