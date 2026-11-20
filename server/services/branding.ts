import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { type AccentColor, accentSchema, isAccent } from "@/lib/accents";
import { recordActivity } from "@/lib/activity";
import { type LogoError, validateBrandLogo } from "@/lib/brand-logo-validate";
import { type DbTransaction, db } from "@/lib/db";
import { instanceBrandLogos, instanceSettings } from "@/lib/db/schema";
import { invalidateBranding, type LogoType } from "@/lib/instance-branding";
import { requireInstanceManage } from "@/server/services/instance-backups";

/**
 * Admin › Instance › Branding: the instance's name, company, default accent
 * and logo (plus an optional dark-mode logo). Every function needs org
 * instance:manage. These are the raw stored values, null meaning "default";
 * the effective branding everyone else reads is lib/instance-branding.
 */

export type BrandTheme = "light" | "dark";

export type BrandingSettings = {
  name: string | null;
  company: string | null;
  accent: AccentColor | null;
  logo: { type: LogoType; src: string } | null;
  logoDark: { type: LogoType; src: string } | null;
};

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((value) => value || null);

export const brandingInputSchema = z.object({
  name: optionalText(60),
  company: optionalText(120),
  accent: accentSchema.nullable(),
});
export type BrandingInput = z.infer<typeof brandingInputSchema>;

export const brandThemeSchema = z.object({ theme: z.enum(["light", "dark"]) });

type Raw = {
  name: string | null;
  company: string | null;
  accent: string | null;
  updatedAt: Date | null;
  logos: Set<string>;
  view: BrandingSettings;
};

async function loadRaw(): Promise<Raw> {
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
  // The same version lib/instance-branding puts in the logo URLs.
  const version = row?.updatedAt ? row.updatedAt.getTime().toString(36) : "0";
  const logo = (theme: BrandTheme) => {
    const found = logos.find((l) => l.theme === theme);
    if (!found) return null;
    const query = theme === "dark" ? `theme=dark&v=${version}` : `v=${version}`;
    return { type: found.type as LogoType, src: `/brand/logo?${query}` };
  };
  const light = logo("light");
  return {
    name: row?.name ?? null,
    company: row?.company ?? null,
    accent: row?.accent ?? null,
    updatedAt: row?.updatedAt ?? null,
    logos: new Set(logos.map((l) => l.theme)),
    view: {
      name: row?.name ?? null,
      company: row?.company ?? null,
      accent: isAccent(row?.accent) ? row.accent : null,
      logo: light,
      // A variant of the light logo only, as lib/instance-branding reads it.
      logoDark: light ? logo("dark") : null,
    },
  };
}

/** After every write: this process reads the change at once, then the feed. */
async function afterWrite(
  actorId: string,
  changed: {
    name?: boolean;
    company?: boolean;
    accent?: boolean;
    logo?: boolean;
    logoDark?: boolean;
  }
): Promise<BrandingSettings> {
  invalidateBranding();
  // Which fields changed, never the bytes or the type.
  await recordActivity({
    actorId,
    action: "instance.brandingChanged",
    entityType: "instance",
    data: {
      nameChanged: String(Boolean(changed.name)),
      companyChanged: String(Boolean(changed.company)),
      accentChanged: String(Boolean(changed.accent)),
      logoChanged: String(Boolean(changed.logo)),
      logoDarkChanged: String(Boolean(changed.logoDark)),
    },
  });
  return (await loadRaw()).view;
}

export async function getBrandingSettings(): Promise<BrandingSettings> {
  await requireInstanceManage();
  return (await loadRaw()).view;
}

export async function saveBranding(
  input: BrandingInput
): Promise<BrandingSettings> {
  const session = await requireInstanceManage();
  const before = await loadRaw();
  await db
    .update(instanceSettings)
    .set({
      brandName: input.name,
      brandCompany: input.company,
      brandAccent: input.accent,
      brandUpdatedAt: new Date(),
    })
    .where(eq(instanceSettings.id, 1));
  return afterWrite(session.user.id, {
    name: before.name !== input.name,
    company: before.company !== input.company,
    accent: before.accent !== input.accent,
  });
}

/**
 * Why an upload was refused: the file itself (LogoError), or a dark logo sent
 * while there is no light one (the dark logo is only its dark-mode variant).
 */
export type BrandLogoError = LogoError | "light_logo_required";

// Thrown inside a logo transaction to roll it back (with its version bump).
class Rollback extends Error {
  constructor(readonly outcome: unknown) {
    super("rollback");
  }
}

/**
 * Runs a logo write with the settings row locked: the version bump comes
 * first, so concurrent logo writes queue on that row and each one sees the
 * logos as the previous one committed them (a dark logo never outlives its
 * light one).
 */
async function lockedLogoWrite<T>(
  now: Date,
  write: (tx: DbTransaction) => Promise<T>
): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      await tx
        .update(instanceSettings)
        .set({ brandUpdatedAt: now })
        .where(eq(instanceSettings.id, 1));
      return write(tx);
    });
  } catch (error) {
    if (error instanceof Rollback) return error.outcome as T;
    throw error;
  }
}

export async function saveBrandLogo(
  theme: BrandTheme,
  bytes: Uint8Array
): Promise<BrandingSettings | { error: BrandLogoError }> {
  const session = await requireInstanceManage();
  // Checked again under the lock below; this one spares the validation.
  if (theme === "dark" && !(await loadRaw()).logos.has("light")) {
    return { error: "light_logo_required" };
  }
  const result = await validateBrandLogo(bytes);
  if (!result.ok) return { error: result.error };
  const now = new Date();
  const refused = await lockedLogoWrite(now, async (tx) => {
    if (theme === "dark") {
      const [light] = await tx
        .select({ theme: instanceBrandLogos.theme })
        .from(instanceBrandLogos)
        .where(eq(instanceBrandLogos.theme, "light"))
        .limit(1);
      if (!light) throw new Rollback(true);
    }
    await tx
      .insert(instanceBrandLogos)
      .values({
        theme,
        bytes: result.bytes,
        contentType: result.type,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: instanceBrandLogos.theme,
        set: { bytes: result.bytes, contentType: result.type, updatedAt: now },
      });
    return false;
  });
  if (refused) return { error: "light_logo_required" };
  return afterWrite(session.user.id, {
    logo: theme === "light",
    logoDark: theme === "dark",
  });
}

export async function removeBrandLogo(
  theme: BrandTheme
): Promise<BrandingSettings> {
  const session = await requireInstanceManage();
  // The dark logo is a variant of the light one: it goes with it, whatever
  // the logos were when this request started.
  const themes: BrandTheme[] = theme === "light" ? ["light", "dark"] : ["dark"];
  const removed = await lockedLogoWrite(new Date(), async (tx) => {
    const rows = await tx
      .delete(instanceBrandLogos)
      .where(inArray(instanceBrandLogos.theme, themes))
      .returning({ theme: instanceBrandLogos.theme });
    // Nothing to remove: no version bump, no activity row.
    if (rows.length === 0) throw new Rollback(null);
    return rows.map((row) => row.theme);
  });
  if (!removed) return (await loadRaw()).view;
  return afterWrite(session.user.id, {
    logo: removed.includes("light"),
    logoDark: removed.includes("dark"),
  });
}
