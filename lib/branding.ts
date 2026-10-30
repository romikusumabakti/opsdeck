/**
 * Whitelabel branding configuration.
 *
 * All deployment-specific identity (app name, company name, email domain)
 * lives here so the codebase stays generic. Values are read by the server at
 * runtime (APP_NAME, COMPANY_NAME, ALLOWED_EMAIL_DOMAIN), never inlined at
 * build time: the Docker build sees no deployment env, so a build-time value
 * would always be the default.
 *
 * The fallback defaults are intentionally generic — set the env vars for
 * any real deployment.
 *
 * Server-only: these read `process.env` at module load. Client code takes the
 * same values from `/api/bootstrap`, and the env-free parts from lib/brands.
 */

import { BRANDS, type BrandName } from "@/lib/brands";

export { BRAND_ICON_SRC, BRANDS, type BrandName } from "@/lib/brands";

export const APP_NAME = process.env.APP_NAME || "OpsDeck";

export const COMPANY_NAME = process.env.COMPANY_NAME || "the company";

export const ALLOWED_EMAIL_DOMAIN =
  process.env.ALLOWED_EMAIL_DOMAIN || "example.com";

/**
 * This deployment's brand (BRAND). Server-only and read per call; the server
 * reads it and passes it down. An unknown value fails boot in lib/env.ts; this
 * fallback only covers local development and tests.
 */
export function brand(): BrandName {
  const value = process.env.BRAND;
  return BRANDS.find((logo) => logo === value) ?? "default";
}

export const DEFAULT_EMAIL_FROM = `${APP_NAME} <no-reply@${ALLOWED_EMAIL_DOMAIN}>`;

export function isAllowedEmail(email: string): boolean {
  return email.toLowerCase().trim().endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);
}
