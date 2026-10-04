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
 * Brands a deployment can choose from. A brand is a logo (lib/brand-logos.ts)
 * plus a colour theme (the `[data-brand]` token blocks in app/globals.css).
 */
export const BRANDS = ["default", "dss"] as const;
export type BrandName = (typeof BRANDS)[number];

/**
 * This deployment's brand (BRAND). Server-only and read per
 * call, not a `NEXT_PUBLIC_` constant: the Docker build sees no deployment env,
 * so a build-time value would always be the default. Server components read it
 * and pass it down. An unknown value fails boot in lib/env.ts; this fallback
 * only covers `next dev` and tests.
 */
export function brand(): BrandName {
  const value = process.env.BRAND;
  return BRANDS.find((logo) => logo === value) ?? "default";
}

/** The favicon, rendered per deployment by app/brand/icon.svg/route.ts. */
export const BRAND_ICON_SRC = "/brand/icon.svg";

export const DEFAULT_EMAIL_FROM = `${APP_NAME} <no-reply@${ALLOWED_EMAIL_DOMAIN}>`;

export function isAllowedEmail(email: string): boolean {
  return email.toLowerCase().trim().endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);
}
