/**
 * Brands a deployment can choose from. A brand is a logo shape
 * (lib/brand-logos.ts) and a default accent colour (lib/accents.ts).
 *
 * Client-safe: no env reads. The deployment's own brand is server config
 * (`brand()` in lib/branding.ts); the SPA gets it from `/api/bootstrap`.
 */
export const BRANDS = ["default", "dss"] as const;
export type BrandName = (typeof BRANDS)[number];

/** The favicon, rendered per deployment by server/routes/brand.ts. */
export const BRAND_ICON_SRC = "/brand/icon.svg";
