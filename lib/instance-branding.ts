import { eq, sql } from "drizzle-orm";
import {
  type AccentColor,
  type BootstrapIcon,
  BRAND_ICON_SRC,
  isAccent,
} from "@/lib/accents";
import { db } from "@/lib/db";
import { instanceBrandLogos, instanceSettings } from "@/lib/db/schema";

/** The name an instance shows until an admin (or the boot seed) sets one. */
export const DEFAULT_APP_NAME = "Menara";

export type LogoType = "image/svg+xml" | "image/png" | "image/webp";

export type InstanceBranding = {
  name: string;
  company: string | null;
  accent: AccentColor;
  logo: { type: LogoType } | null;
  logoDark: { type: LogoType } | null;
  /** brand_updated_at in ms, base36; "0" when never written. Cache-busts the logo URLs. */
  version: string;
};

/** The favicon for `b`: the uploaded logo (a PNG of a raster one), or the built-in mark. */
export function brandIcon(b: InstanceBranding): BootstrapIcon {
  if (!b.logo) {
    return { src: BRAND_ICON_SRC, type: "image/svg+xml", custom: false };
  }
  return b.logo.type === "image/svg+xml"
    ? { src: `/brand/icon.svg?v=${b.version}`, type: b.logo.type, custom: true }
    : {
        src: `/brand/icon.png?v=${b.version}`,
        type: "image/png",
        custom: true,
      };
}

/** The uploaded logo's URLs, versioned; null while the built-in mark shows. */
export function brandLogo(
  b: InstanceBranding
): { src: string; darkSrc: string | null } | null {
  if (!b.logo) return null;
  return {
    src: `/brand/logo?v=${b.version}`,
    darkSrc: b.logoDark ? `/brand/logo?theme=dark&v=${b.version}` : null,
  };
}

export const BRANDING_TTL_MS = 30_000;
/** How long a failed load is served from the fallback before retrying. */
const BRANDING_RETRY_MS = 5_000;

type Theme = "light" | "dark";

let cached: { value: InstanceBranding; at: number } | null = null;
let inflight: Promise<InstanceBranding> | null = null;
let generation = 0;
let primedName: string | null = null;
const logoBytes = new Map<
  Theme,
  { version: string; value: { bytes: Uint8Array; type: LogoType } | null }
>();

function envDefaults(): InstanceBranding {
  return {
    name: process.env.APP_NAME || DEFAULT_APP_NAME,
    company: null,
    accent: "neutral",
    logo: null,
    logoDark: null,
    version: "0",
  };
}

async function load(): Promise<InstanceBranding> {
  const [[row], logos] = await Promise.all([
    db
      .select({
        name: instanceSettings.brandName,
        company: instanceSettings.brandCompany,
        accent: instanceSettings.brandAccent,
        updatedAt: instanceSettings.brandUpdatedAt,
      })
      .from(instanceSettings)
      .where(eq(instanceSettings.id, 1))
      .limit(1),
    db
      .select({
        theme: instanceBrandLogos.theme,
        type: instanceBrandLogos.contentType,
      })
      .from(instanceBrandLogos),
  ]);
  const typeOf = (theme: Theme) => {
    const found = logos.find((l) => l.theme === theme);
    return found ? { type: found.type as LogoType } : null;
  };
  return {
    name: row?.name || DEFAULT_APP_NAME,
    company: row?.company || null,
    accent: isAccent(row?.accent) ? row.accent : "neutral",
    logo: typeOf("light"),
    logoDark: typeOf("dark"),
    version: row?.updatedAt ? row.updatedAt.getTime().toString(36) : "0",
  };
}

/**
 * The instance branding, cached for BRANDING_TTL_MS (other processes' writes
 * show up within that). Concurrent callers share one load; a failed load
 * keeps the last good value, or the env defaults before the first one.
 */
export async function getBranding(): Promise<InstanceBranding> {
  if (cached && Date.now() - cached.at < BRANDING_TTL_MS) return cached.value;
  if (inflight) return inflight;
  // invalidateBranding() bumps the generation; a load that started before it
  // must neither fill the cache nor clear a newer load's in-flight slot.
  const started = generation;
  const promise: Promise<InstanceBranding> = load()
    .then((value) => {
      if (started === generation) cached = { value, at: Date.now() };
      return value;
    })
    .catch((error) => {
      console.error("Failed to load the instance branding:", error);
      const value = cached?.value ?? envDefaults();
      // Negative cache: retry after BRANDING_RETRY_MS, not on every call.
      if (started === generation) {
        cached = {
          value,
          at: Date.now() - BRANDING_TTL_MS + BRANDING_RETRY_MS,
        };
      }
      return value;
    })
    .finally(() => {
      if (inflight === promise) inflight = null;
    });
  inflight = promise;
  return promise;
}

export async function getBrandLogoBytes(
  theme: Theme
): Promise<{ bytes: Uint8Array; type: LogoType } | null> {
  const branding = await getBranding();
  if (!(theme === "dark" ? branding.logoDark : branding.logo)) return null;
  const hit = logoBytes.get(theme);
  if (hit && hit.version === branding.version) return hit.value;
  const [row] = await db
    .select({
      bytes: instanceBrandLogos.bytes,
      type: instanceBrandLogos.contentType,
    })
    .from(instanceBrandLogos)
    .where(eq(instanceBrandLogos.theme, theme))
    .limit(1);
  const value = row ? { bytes: row.bytes, type: row.type as LogoType } : null;
  logoBytes.set(theme, { version: branding.version, value });
  return value;
}

/** Call after a branding write so this process reads it at once. */
export function invalidateBranding(): void {
  generation += 1;
  cached = null;
  inflight = null;
  logoBytes.clear();
}

const clean = (value: string | undefined) => value?.trim() || null;

/**
 * One-time boot seed of the stored branding from APP_NAME, COMPANY_NAME and
 * BRAND, so an instance configured through env keeps its identity. A single
 * conditional UPDATE, so two booting processes cannot both write, and a row an
 * admin cleared (brand_updated_at set) is never seeded again. `true` = wrote.
 */
export async function seedBrandingFromEnv(
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  const name = clean(env.APP_NAME);
  const company = clean(env.COMPANY_NAME);
  const accent = clean(env.BRAND) === "acme" ? "blue" : null;
  if (!(name || company || accent)) return false;
  const rows = await db.execute(sql`
    UPDATE instance_settings
    SET brand_name = ${name}, brand_company = ${company},
      brand_accent = ${accent}, brand_updated_at = now()
    WHERE id = 1 AND brand_name IS NULL AND brand_company IS NULL
      AND brand_accent IS NULL AND brand_updated_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM instance_brand_logos)
    RETURNING id`);
  return rows.length > 0;
}

/** Boot: seed, then load. Logs and swallows errors; the app boots on defaults. */
export async function primeBranding(): Promise<void> {
  try {
    await seedBrandingFromEnv();
    invalidateBranding();
    primedName = (await getBranding()).name;
  } catch (error) {
    console.error("Failed to prime the instance branding:", error);
  }
}

/** The primed name, only for better-auth's init (it cannot await). */
export function bootBrandName(): string {
  return primedName ?? (process.env.APP_NAME || DEFAULT_APP_NAME);
}
