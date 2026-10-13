import { z } from "zod";

/**
 * Background motifs: one traditional ornament per major region, ordered west
 * to east by the longitude of its home (tests/motifs.test.ts checks this).
 * Names are proper nouns and stay the same in every locale; captions live in
 * the `motifs` messages namespace. Masks are public/motifs/<slug>.webp, built
 * from design/motifs by scripts/build-motifs.mjs.
 * See docs/superpowers/specs/2026-10-14-nusantara-motifs-design.md.
 */
type MotifEntry = {
  slug: string;
  name: string;
  /** The name in the local language, when it differs from `name`. */
  localName?: string;
  longitude: number;
  sourceUrl: string;
};

export const MOTIFS = [
  {
    slug: "pintu-aceh",
    name: "Pintu Aceh",
    localName: "Pinto Aceh",
    longitude: 95.32,
    sourceUrl: "https://www.budayaaceh.com/wbtb/pinto-aceh/43",
  },
  {
    slug: "gorga",
    name: "Gorga",
    localName: "Gorga Simeol-eol",
    longitude: 99.06,
    sourceUrl: "https://www.iwarebatik.org/batikdescription/gorga-simeol-meol/",
  },
  {
    slug: "pucuk-rebung",
    name: "Pucuk Rebung",
    localName: "Pucuak Rabuang",
    longitude: 100.37,
    sourceUrl: "https://journal.ugm.ac.id/wisdom/article/download/3438/9403",
  },
  {
    slug: "megamendung",
    name: "Megamendung",
    longitude: 108.55,
    sourceUrl:
      "https://jurnal.isbi.ac.id/index.php/panggung/article/download/60/60",
  },
  {
    slug: "kawung",
    name: "Kawung",
    longitude: 110.36,
    sourceUrl: "https://journal.ugm.ac.id/wisdom/article/download/13217/9459",
  },
  {
    slug: "batang-garing",
    name: "Batang Garing",
    longitude: 113.92,
    sourceUrl:
      "https://ojs.badanbahasa.kemdikbud.go.id/jurnal/index.php/kandai/article/download/230/79",
  },
  {
    slug: "patra-punggel",
    name: "Patra Punggel",
    longitude: 115.22,
    sourceUrl:
      "https://jurnal.isbi.ac.id/index.php/panggung/article/download/1907/1236",
  },
  {
    slug: "pa-barre-allo",
    name: "Pa' Barre Allo",
    localName: "Passura'",
    longitude: 119.89,
    sourceUrl: "https://ojs.unm.ac.id/ijpss/article/view/24653",
  },
  {
    slug: "mamuli",
    name: "Mamuli",
    longitude: 120.26,
    sourceUrl: "https://www.metmuseum.org/art/collection/search/855904",
  },
  {
    slug: "tenun-tanimbar",
    name: "Tenun Tanimbar",
    localName: "Tais",
    longitude: 131.3,
    sourceUrl:
      "https://ambon.antaranews.com/berita/41286/tenun-ikat-tanimbar-dapat-sertifikat-hki",
  },
  {
    slug: "ukiran-asmat",
    name: "Ukiran Asmat",
    longitude: 138.13,
    sourceUrl:
      "https://bowers.org/collections-blog/progenitor-protection-wooden-shields-of-the-asmat",
  },
] as const satisfies readonly MotifEntry[];

export type MotifSlug = (typeof MOTIFS)[number]["slug"];

export const MOTIF_SLUGS = MOTIFS.map((m) => m.slug) as [
  MotifSlug,
  ...MotifSlug[],
];

export const motifPreferenceSchema = z.enum([
  "daily",
  "none",
  ...MOTIF_SLUGS,
] as const);
/** `daily` rotates (the default), `none` hides the motif, a slug pins one. */
export type MotifPreference = z.infer<typeof motifPreferenceSchema>;

export function isMotifSlug(value: unknown): value is MotifSlug {
  return typeof value === "string" && (MOTIF_SLUGS as string[]).includes(value);
}

export function getMotif(slug: MotifSlug): MotifEntry {
  // Every MotifSlug comes from MOTIFS, so the lookup always succeeds.
  return MOTIFS.find((m) => m.slug === slug) as MotifEntry;
}

/**
 * The user's preference. Unset or unknown stored values (a hand edit, a motif
 * removed later) fall back to daily, like effectiveAccent does for colours.
 */
export function effectiveMotifPreference(
  user: { motif?: string | null } | null | undefined
): MotifPreference {
  const stored = user?.motif;
  return stored === "none" || isMotifSlug(stored) ? stored : "daily";
}

/** The `users.motif` value for a preference: daily is stored as NULL. */
export function storedMotif(
  pref: MotifPreference
): Exclude<MotifPreference, "daily"> | null {
  return pref === "daily" ? null : pref;
}

const DAY_MS = 86_400_000;

/** Days since 1970-01-01 for the calendar date `date` falls on in `timeZone`. */
function dayNumber(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day")) / DAY_MS;
}

/**
 * Today's motif: everyone sees the same one on the same day in `timeZone`
 * (pass APP_TIMEZONE), walking west to east and starting over every
 * MOTIFS.length days.
 */
export function dailyMotif(date: Date, timeZone: string): MotifSlug {
  const n = MOTIF_SLUGS.length;
  const index = ((dayNumber(date, timeZone) % n) + n) % n;
  return MOTIF_SLUGS[index]!;
}

/** The motif to draw, or null for none. `today` is dailyMotif's result. */
export function resolveMotif(
  pref: MotifPreference,
  today: MotifSlug
): MotifSlug | null {
  if (pref === "none") return null;
  return pref === "daily" ? today : pref;
}

export function motifSrc(slug: MotifSlug): string {
  return `/motifs/${slug}.webp`;
}
