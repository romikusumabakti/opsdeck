# Nusantara Motif Watermarks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Faint, accent-coloured Nusantara ornaments in the corners of the unauthenticated pages and the sidebar, rotating daily, pinnable or hideable per account, each with a short cultural note.

**Architecture:** Eleven AI-generated PNGs become alpha-only WebP masks in `public/motifs/`; a `<div>` masks `bg-primary` with them, so theme and accent colour come from CSS. `lib/motifs.ts` holds the ordered motif list, the WIB daily rotation and preference parsing; the preference lives in `users.motif` and is edited optimistically through a generic latest-wins hook extracted from the accent provider.

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind CSS 4, shadcn/ui (base-ui), next-intl (ar/en/es/id/zh), better-auth 1.7 `additionalFields`, Drizzle + Postgres, zod 4, sharp (asset script, Node), Bun test + happy-dom, Biome.

**Spec:** `docs/superpowers/specs/2026-10-14-nusantara-motifs-design.md`

## Global Constraints

- Never add `Co-Authored-By: Claude` or any Claude attribution to commits.
- Every new user-facing string goes into all 5 `messages/*.json` (ar, en, es, id, zh).
- Motif titles and local names are proper nouns: same in every locale, kept in `lib/motifs.ts`, not in messages.
- Order is west → east by `longitude`; a test enforces it.
- Daily rotation uses `APP_TIMEZONE` (`lib/timezone.ts`, default `Asia/Jakarta`), never the server's local zone.
- `users.motif`: `NULL` = daily, otherwise `none` or a slug. No CHECK constraint; unknown values fall back to daily.
- sharp hangs under Bun on this machine: the asset script runs with `node`.
- Watermarks are decorative: `aria-hidden`, `pointer-events-none`, `print:hidden`, `forced-colors:hidden`.
- Live DB rollout: backup → dry-run (COMMIT→ROLLBACK) → apply, before the deploy. The user runs the Jenkins deploy.
- Gates: `bunx biome ci .`, `bunx tsc --noEmit` exit 0, `bun test`, `bun run build` exit code 0 (not the "Compiled successfully" line).

## Review Focus

1. **WIB midnight on a UTC server** — prod containers run in UTC; the motif must flip at 00:00 WIB (17:00 UTC), not 00:00 UTC. Pinned in Task 1.
2. **A stored motif that no longer exists** (removed slug, hand edit) — must render the daily motif, never a 404 mask image or a crash. Pinned in Task 1 (`effectiveMotifPreference`) and Task 2 (no orphan/missing assets).
3. **Watermark painting over sidebar menu items** — absolutely positioned layers paint above non-positioned siblings; the sidebar layer needs `-z-10` inside an `isolate` wrapper. Checked in Task 7 visual QA.
4. **RTL (ar)** — the sidebar sits on the right; its watermark mirrors (`rtl:-scale-x-100`) so it keeps hugging the same edge. Checked in Task 8 visual QA.
5. **Save failure / rapid switching** — latest choice wins, failed lone save rolls back with a toast; the accent's behaviour must not regress in the refactor. Pinned in Task 3 (moved tests + motif case).

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/motifs.ts` (create) | Motif list, slugs, preference schema/parsing, daily rotation, asset URL |
| `tests/motifs.test.ts` (create) | Order, rotation, preference parsing, assets present |
| `design/motifs/*.png`, `design/motifs/prompts.json` (create) | Source art + the prompts that made it |
| `scripts/build-motifs.mjs` (create) | PNG → alpha-only WebP masks |
| `public/motifs/*.webp` (create) | Served masks |
| `lib/optimistic-preference.ts` (create; replaces `lib/accent-state.ts`) | Generic latest-wins reducer |
| `hooks/use-optimistic-preference.ts` (create) | Save queue + rollback/toast around the reducer |
| `tests/optimistic-preference.test.ts` (create; replaces `tests/accent-state.test.ts`) | Reducer tests |
| `components/accent-provider.tsx` (modify) | Uses the hook |
| `drizzle/20261014000000_user_motif/migration.sql` (create) | `users.motif` |
| `lib/db/schema.ts`, `lib/auth.ts`, `actions/profile.ts` (modify) | Column, session field, `setMotif` |
| `messages/*.json` (modify) | `motifs` namespace |
| `tests/motif-messages.test.ts` (create) | Locale parity for `motifs` |
| `components/motif-watermark.tsx` (create) | The masked layer |
| `components/motif-info.tsx` (create) | Caption body + popover + dialog |
| `components/motif-provider.tsx` (create) | Client preference context |
| `app/[locale]/layout.tsx`, `components/app-sidebar.tsx`, `components/user-menu.tsx`, `components/command-palette.tsx` (modify) | Wiring |
| `README.md` (modify) | How to add/replace a motif |

---

### Task 1: Motif data and daily rotation

**Files:**
- Create: `lib/motifs.ts`
- Test: `tests/motifs.test.ts`

**Interfaces:**
- Produces:
  - `MOTIFS: readonly MotifEntry[]` (entries below, in order), `type MotifSlug`, `MOTIF_SLUGS`
  - `type MotifPreference = "daily" | "none" | MotifSlug`, `motifPreferenceSchema` (zod)
  - `isMotifSlug(v: unknown): v is MotifSlug`
  - `getMotif(slug: MotifSlug): MotifEntry`
  - `effectiveMotifPreference(user: { motif?: string | null } | null | undefined): MotifPreference`
  - `storedMotif(pref: MotifPreference): Exclude<MotifPreference, "daily"> | null`
  - `dailyMotif(date: Date, timeZone: string): MotifSlug`
  - `resolveMotif(pref: MotifPreference, today: MotifSlug): MotifSlug | null`
  - `motifSrc(slug: MotifSlug): string` → `/motifs/<slug>.webp`

- [ ] **Step 1: Write the failing test** — `tests/motifs.test.ts`

```ts
import { describe, expect, it } from "bun:test";
import {
  dailyMotif,
  effectiveMotifPreference,
  getMotif,
  isMotifSlug,
  MOTIF_SLUGS,
  MOTIFS,
  motifPreferenceSchema,
  motifSrc,
  resolveMotif,
  storedMotif,
} from "@/lib/motifs";

const WIB = "Asia/Jakarta";

describe("MOTIFS", () => {
  it("runs west to east", () => {
    for (let i = 1; i < MOTIFS.length; i++) {
      expect(MOTIFS[i].longitude).toBeGreaterThan(MOTIFS[i - 1].longitude);
    }
  });

  it("has eleven unique slugs", () => {
    expect(MOTIFS).toHaveLength(11);
    expect(new Set(MOTIF_SLUGS).size).toBe(11);
  });

  it("links every motif to an https source", () => {
    for (const m of MOTIFS) expect(m.sourceUrl).toStartWith("https://");
  });
});

describe("dailyMotif", () => {
  it("is the same all day in WIB", () => {
    expect(dailyMotif(new Date("2026-10-13T17:00:00Z"), WIB)).toBe(
      dailyMotif(new Date("2026-10-14T16:59:59Z"), WIB)
    );
  });

  // Prod runs in UTC: the flip must be at 00:00 WIB = 17:00 UTC.
  it("moves to the next motif at WIB midnight, not UTC midnight", () => {
    const before = dailyMotif(new Date("2026-10-13T16:59:59Z"), WIB);
    const after = dailyMotif(new Date("2026-10-13T17:00:00Z"), WIB);
    const i = MOTIF_SLUGS.indexOf(before);
    expect(after).toBe(MOTIF_SLUGS[(i + 1) % MOTIF_SLUGS.length]);
    expect(dailyMotif(new Date("2026-10-14T00:00:00Z"), WIB)).toBe(after);
  });

  it("cycles every eleven days", () => {
    const day = new Date("2026-10-14T05:00:00Z");
    const later = new Date(day.getTime() + 11 * 86_400_000);
    expect(dailyMotif(later, WIB)).toBe(dailyMotif(day, WIB));
  });
});

describe("preferences", () => {
  it("accepts daily, none and every slug, nothing else", () => {
    for (const v of ["daily", "none", ...MOTIF_SLUGS]) {
      expect(motifPreferenceSchema.safeParse(v).success).toBe(true);
    }
    for (const v of ["", "random", "Kawung", null, 3]) {
      expect(motifPreferenceSchema.safeParse(v).success).toBe(false);
    }
  });

  it("falls back to daily for unset or unknown stored values", () => {
    expect(effectiveMotifPreference(null)).toBe("daily");
    expect(effectiveMotifPreference({ motif: null })).toBe("daily");
    expect(effectiveMotifPreference({ motif: "removed-motif" })).toBe("daily");
    expect(effectiveMotifPreference({ motif: "none" })).toBe("none");
    expect(effectiveMotifPreference({ motif: "kawung" })).toBe("kawung");
  });

  it("stores daily as null", () => {
    expect(storedMotif("daily")).toBeNull();
    expect(storedMotif("none")).toBe("none");
    expect(storedMotif("mamuli")).toBe("mamuli");
  });

  it("resolves the motif to show", () => {
    expect(resolveMotif("daily", "gorga")).toBe("gorga");
    expect(resolveMotif("none", "gorga")).toBeNull();
    expect(resolveMotif("kawung", "gorga")).toBe("kawung");
  });

  it("recognises slugs", () => {
    expect(isMotifSlug("ukiran-asmat")).toBe(true);
    expect(isMotifSlug("daily")).toBe(false);
  });

  it("finds a motif and its mask", () => {
    expect(getMotif("pintu-aceh").localName).toBe("Pinto Aceh");
    expect(motifSrc("kawung")).toBe("/motifs/kawung.webp");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/motifs.test.ts`
Expected: FAIL — cannot resolve `@/lib/motifs`.

- [ ] **Step 3: Write the implementation** — `lib/motifs.ts`

```ts
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
    sourceUrl: "https://jurnal.isbi.ac.id/index.php/panggung/article/download/60/60",
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
  return (
    typeof value === "string" && (MOTIF_SLUGS as string[]).includes(value)
  );
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
  return MOTIF_SLUGS[dayNumber(date, timeZone) % MOTIF_SLUGS.length];
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/motifs.test.ts && bunx tsc --noEmit`
Expected: all pass, tsc exit 0. If `z.enum([... ] as const)` with the spread does not type-check under zod 4, use `z.enum(["daily", "none", ...MOTIF_SLUGS] as [string, ...string[]])` and narrow `MotifPreference` with `"daily" | "none" | MotifSlug` explicitly — the tests stay the same.

- [ ] **Step 5: Commit**

```bash
git add lib/motifs.ts tests/motifs.test.ts
git commit -m "feat(motifs): motif list, west-to-east order and WIB daily rotation"
```

---

### Task 2: Motif assets

**Files:**
- Create: `design/motifs/<slug>.png` ×11, `design/motifs/prompts.json`
- Create: `scripts/build-motifs.mjs`
- Create: `public/motifs/<slug>.webp` ×11 (generated)
- Modify: `package.json` (devDependency `sharp`)
- Test: `tests/motifs.test.ts` (append)

**Interfaces:**
- Consumes: `MOTIF_SLUGS`, `motifSrc` from Task 1.
- Produces: `public/motifs/<slug>.webp` for every slug.

- [ ] **Step 1: Write the failing test** — append to `tests/motifs.test.ts`

```ts
import { existsSync, readdirSync } from "node:fs";

describe("motif assets", () => {
  it("has a mask for every motif and no orphans", () => {
    const files = readdirSync("public/motifs").sort();
    expect(files).toEqual(MOTIF_SLUGS.map((s) => `${s}.webp`).sort());
  });

  it("has source art for every motif", () => {
    for (const slug of MOTIF_SLUGS) {
      expect(existsSync(`design/motifs/${slug}.png`)).toBe(true);
    }
  });
});
```

(Move the `node:fs` import to the top of the file with the others.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/motifs.test.ts`
Expected: FAIL — `ENOENT ... public/motifs`.

- [ ] **Step 3: Copy the chosen source art**

The art was picked during brainstorming from `gpt-image-2.5-sunburst` (quality medium) probes; copies live in `/tmp/motif-probe/picks/` and `~/backups/opsdeck/motif-probe/picks/` (use whichever exists).

```bash
P=/tmp/motif-probe/picks; [ -d "$P" ] || P=~/backups/opsdeck/motif-probe/picks
mkdir -p design/motifs
cp "$P/01-pintu-aceh.png"    design/motifs/pintu-aceh.png
cp "$P/02-gorga.png"         design/motifs/gorga.png
cp "$P/03-pucuk-rebung.png"  design/motifs/pucuk-rebung.png
cp "$P/04-megamendung.png"   design/motifs/megamendung.png
cp "$P/05-kawung.png"        design/motifs/kawung.png
cp "$P/06-batang-garing.png" design/motifs/batang-garing.png
cp "$P/07-patra-punggel.png" design/motifs/patra-punggel.png
cp "$P/08-pa-barre-allo.png" design/motifs/pa-barre-allo.png
cp "$P/09-mamuli.png"        design/motifs/mamuli.png
cp "$P/10-tanimbar.png"      design/motifs/tenun-tanimbar.png
cp "$P/11-asmat.png"         design/motifs/ukiran-asmat.png
ls design/motifs | wc -l   # 11
```

- [ ] **Step 4: Record the prompts** — `design/motifs/prompts.json`

```json
{
  "model": "gpt-image-2.5-sunburst",
  "params": { "quality": "medium", "size": "1024x1024", "background": "transparent", "output_format": "png" },
  "template": "A faithful, authentic rendering of the traditional Indonesian ornament: {subject}.\nStyle: monochrome line ornament only, pure solid black (#000000) strokes on a fully transparent background, no shading, no gradients, no grey, no texture, no text, no border, no frame.\nComposition: a corner ornament like a letterhead flourish or document watermark — the motif is anchored in the bottom-right corner and grows from there, filling roughly the bottom-right two thirds and fading out (fewer, sparser elements) toward the top-left, which stays empty.\nAccuracy matters more than decoration: keep the motif's real, recognisable shapes, proportions and symmetry as craftspeople make it; do not invent a generic spiral or mix in other cultures' motifs.",
  "subjects": {
    "pintu-aceh": "Pinto Aceh (Pintu Aceh) from Aceh, Sumatra, as on the famous Pinto Aceh gold filigree brooch: a symmetrical gateway outline with a gently curved, pointed roof-like top and stepped shoulders, built of several concentric parallel frames; the fields between frames are filled with tiny filigree spirals and small round dots like gold granulation, plus small Acehnese floral (bungong) sprigs. Fine, delicate jewellery-like linework. NOT Gothic tracery, NOT Thai temple ornament, no large leafy vines.",
    "gorga": "Gorga, the carved ornament of the Batak Toba people (North Sumatra) on the gable boards of rumah bolon houses: bold ribbon-like strokes of constant width forming tightly packed pairs of interlocking spirals that face each other (like curled fern shoots meeting), compact and dense, combined with a zigzag sawtooth border band (gorga ipon-ipon) of triangular teeth along the edges. Flat graphic bands as if painted in the Batak red-white-black palette. NOT European/Celtic scrollwork, NO acanthus leaves, NO leaves at all.",
    "pucuk-rebung": "Pucuk Rebung (Pucuak Rabuang), the Malay and Minangkabau bamboo-shoot motif from songket textiles and Rumah Gadang carvings: a row of tall isosceles triangles like young bamboo shoots, each filled with nested chevrons and small curling scrolls, arranged as a border band",
    "megamendung": "Batik Megamendung from Cirebon, West Java: stacked rain-cloud forms, each cloud built from 5 to 9 concentric parallel outlines with characteristic pointed, triangular cloud tips and gentle curls",
    "kawung": "Batik Kawung from Yogyakarta, Java: four ellipses (stylised sugar-palm fruit) meeting at a centre point to form a four-petal cross, repeated on a square diagonal grid, with a small dot or cross in each gap",
    "batang-garing": "Batang Garing, the tree-of-life motif of the Dayak Ngaju people of Central Kalimantan: a vertical spear-tip-shaped tree pointing upward, with paired branches curving symmetrically on both sides ending in curled tips, standing on a base with curled roots and a sacred jar (guci), surrounded by Dayak curling scroll ornament",
    "patra-punggel": "Patra Punggel from Bali as carved in paras stone on candi bentar temple gates: each unit is a chunky curl that bends back on itself — a bulbous mango-seed-shaped core (batun poh), a crest of serrated rooster-comb lobes (janggar siap), jackfruit-pulp-like rounded serrations (ampas nangka) and a tight piglet-ear curl (kuping guling) at the tip; units chained into a running scroll. Crisp, deep, chunky carving forms. NOT European acanthus, NOT baroque, NOT Thai kranok.",
    "pa-barre-allo": "Passura' carving of the Toraja people (South Sulawesi) on tongkonan house walls, featuring Pa' Barre Allo: a round sun disc with curved, petal-like rays, set in a rectangular panel; around it Toraja passura' patterns — Pa' Tedong buffalo-horn crescents, Pa' Bulintong round whorls, and curving S-shaped tendrils with rounded hooks — arranged symmetrically in framed panels and bands, like the carved and painted (red, black, white, yellow) wall panels. NOT Greek meander, NOT Aztec, no square key-fret spirals.",
    "mamuli": "The Mamuli motif from Sumba, East Nusa Tenggara, as woven on hinggi ikat cloth: the omega (Ω)-shaped mamuli ear-ornament form — a closed loop opening into two outward-curling feet — repeated in mirrored rows within horizontal ikat bands with stepped geometric edges",
    "tenun-tanimbar": "Tais, the warp-ikat cloth of the Tanimbar Islands (Yamdena, Maluku): narrow vertical warp stripes, each holding small repeated motifs with blurred, slightly feathered stepped edges typical of warp ikat — a stylised orchid (anggrek) flower, crescent moons, small paired flag shapes, and twin arrowheads (tunis) — separated by plain thin stripes. Rendered as a single-colour line/silhouette ornament. NOT cross-stitch, NOT embroidery, NOT Nordic knitting patterns.",
    "ukiran-asmat": "Asmat wood carving from southern Papua as on Asmat shields (jamasj) and canoe prow ornaments: a tall carved panel in relief whose design is made of mirrored, back-to-back hooked curves and loops — the bipane (double-curved shell nose ornament), the praying-mantis (wenet) limbs as angular bent hooks, hornbill-beak curves and flying-fox wing shapes — with open-work cut-outs and carved grooves outlining each form. Organic, bold, symmetrical. NOT Maori koru, NOT tribal tattoo, NOT Celtic."
  }
}
```

- [ ] **Step 5: Add sharp as an explicit devDependency**

It is already in `node_modules` (Next's optional dependency); declare it so the script does not rely on that.

```bash
V=$(node -p "require('./node_modules/sharp/package.json').version")
bun add -d "sharp@$V"
```

- [ ] **Step 6: Write the build script** — `scripts/build-motifs.mjs`

```js
// Build the motif masks the app serves from the generated source art.
// Each design/motifs/<slug>.png (black on transparent) becomes
// public/motifs/<slug>.webp: black RGB plus the source's alpha channel, which
// is all CSS mask-image reads. Run with Node — sharp hangs under Bun here:
//   node scripts/build-motifs.mjs
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const SRC = "design/motifs";
const OUT = "public/motifs";
const SIZE = 1024;

await mkdir(OUT, { recursive: true });
for (const file of (await readdir(SRC)).filter((f) => f.endsWith(".png"))) {
  const slug = path.basename(file, ".png");
  const alpha = await sharp(path.join(SRC, file))
    .resize(SIZE, SIZE, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer();
  await sharp({
    create: { width: SIZE, height: SIZE, channels: 3, background: "#000" },
  })
    .joinChannel(alpha, { raw: { width: SIZE, height: SIZE, channels: 1 } })
    .webp({ quality: 80, alphaQuality: 90, effort: 6 })
    .toFile(path.join(OUT, `${slug}.webp`));
  console.log(slug);
}
```

- [ ] **Step 7: Build and inspect**

```bash
node scripts/build-motifs.mjs
ls -l public/motifs   # 11 files; expect roughly 20–80 KB each
magick public/motifs/kawung.webp -alpha extract -format '%[fx:mean]\n' info:   # ≈ 0.1 (mostly transparent)
```

If any file exceeds ~120 KB, lower `quality`/`alphaQuality` to 70/80 and rebuild.

- [ ] **Step 8: Run test to verify it passes**

Run: `bun test tests/motifs.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add design/motifs scripts/build-motifs.mjs public/motifs package.json bun.lock tests/motifs.test.ts
git commit -m "feat(motifs): source art, prompts and alpha-mask build script"
```

---

### Task 3: Generic optimistic preference (refactor the accent)

**Files:**
- Create: `lib/optimistic-preference.ts` (replaces `lib/accent-state.ts`)
- Create: `hooks/use-optimistic-preference.ts`
- Create: `tests/optimistic-preference.test.ts` (replaces `tests/accent-state.test.ts`)
- Modify: `components/accent-provider.tsx`
- Delete: `lib/accent-state.ts`, `tests/accent-state.test.ts`

**Interfaces:**
- Produces:
  - `PreferenceState<T>`, `initialPreferenceState<T>(v)`, `requestPreference(state, v)`, `settlePreference(state, id, v, ok)`, `skipPreference(state)`, `syncPreference(state, server)` — same semantics as the accent versions, generic over `T extends string`.
  - `useOptimisticPreference<T extends string>(opts: { initial: T; save: (v: T) => Promise<{ success: boolean }>; apply?: (v: T) => void; failedMessage: string }): [T, (next: T) => void]`

- [ ] **Step 1: Move the reducer tests**

```bash
git mv tests/accent-state.test.ts tests/optimistic-preference.test.ts
```

In `tests/optimistic-preference.test.ts`, rename imports and calls — no behaviour change:

| Old | New |
|---|---|
| `from "@/lib/accent-state"` | `from "@/lib/optimistic-preference"` |
| `AccentState` | `PreferenceState<AccentColor>` |
| `initialAccentState` | `initialPreferenceState` |
| `requestAccent` | `requestPreference` |
| `settleAccent` | `settlePreference` |
| `skipAccent` | `skipPreference` |
| `syncAccent` | `syncPreference` |
| `describe("accent state"` | `describe("optimistic preference"` |

Then append one case with a second value type, so the generic is exercised:

```ts
import type { MotifPreference } from "@/lib/motifs";

describe("optimistic preference with motifs", () => {
  it("rolls a failed latest save back to the confirmed motif", () => {
    let state = initialPreferenceState<MotifPreference>("daily");
    const a = requestPreference(state, "kawung");
    if (!a) throw new Error("expected a request");
    const b = requestPreference(a.state, "none");
    if (!b) throw new Error("expected a request");
    state = settlePreference(b.state, a.id, "kawung", true).state;
    const s = settlePreference(state, b.id, "none", false);
    expect(s.repaint).toBe("kawung");
    expect(s.toast).toBe(true);
    expect(s.state).toMatchObject({ shown: "kawung", confirmed: "kawung", inFlight: 0 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/optimistic-preference.test.ts`
Expected: FAIL — cannot resolve `@/lib/optimistic-preference`.

- [ ] **Step 3: Create the generic reducer**

```bash
git mv lib/accent-state.ts lib/optimistic-preference.ts
```

Rewrite `lib/optimistic-preference.ts` so it reads:

```ts
/**
 * Latest-wins state for a user preference that the UI applies at once and
 * saves in the background (accent colour, background motif). `shown` is what
 * the page displays, `confirmed` the last value the server accepted, `latest`
 * the id of the most recent request, and `inFlight` how many requests have
 * been made but not yet settled or skipped.
 */
export type PreferenceState<T extends string> = {
  shown: T;
  confirmed: T;
  latest: number;
  inFlight: number;
};

export function initialPreferenceState<T extends string>(
  value: T
): PreferenceState<T> {
  return { shown: value, confirmed: value, latest: 0, inFlight: 0 };
}

/** A new request shows at once. `null` when it is already what is shown. */
export function requestPreference<T extends string>(
  state: PreferenceState<T>,
  value: T
): { state: PreferenceState<T>; id: number } | null {
  if (value === state.shown) return null;
  const id = state.latest + 1;
  return {
    state: { ...state, shown: value, latest: id, inFlight: state.inFlight + 1 },
    id,
  };
}

/**
 * Record the outcome of request `id` (which asked for `value`). Latest wins:
 * a failure only rolls the UI back when no newer request exists, and it rolls
 * back to the last confirmed value, not to whatever was shown before.
 */
export function settlePreference<T extends string>(
  state: PreferenceState<T>,
  id: number,
  value: T,
  ok: boolean
): { state: PreferenceState<T>; repaint: T | null; toast: boolean } {
  const inFlight = Math.max(0, state.inFlight - 1);
  if (ok) {
    return {
      state: { ...state, confirmed: value, inFlight },
      repaint: null,
      toast: false,
    };
  }
  if (id !== state.latest) {
    return { state: { ...state, inFlight }, repaint: null, toast: false };
  }
  return {
    state: { ...state, shown: state.confirmed, inFlight },
    repaint: state.confirmed,
    toast: true,
  };
}

/**
 * Drop a request without saving it because a newer one supersedes it. It is
 * no longer in flight and never settles, so it cannot roll anything back.
 */
export function skipPreference<T extends string>(
  state: PreferenceState<T>
): PreferenceState<T> {
  return { ...state, inFlight: Math.max(0, state.inFlight - 1) };
}

/**
 * Follow the server-rendered value (e.g. changed on another device). Ignored
 * while a request is in flight: that flow converges on its own.
 */
export function syncPreference<T extends string>(
  state: PreferenceState<T>,
  server: T
): PreferenceState<T> {
  if (state.inFlight > 0) return state;
  if (state.shown === server && state.confirmed === server) return state;
  return { ...state, shown: server, confirmed: server };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/optimistic-preference.test.ts`
Expected: PASS (all moved accent cases + the motif case).

- [ ] **Step 5: Extract the save queue into a hook** — `hooks/use-optimistic-preference.ts`

This is the body of today's `AccentProvider.setAccent` + its sync effect, made generic. Read `components/accent-provider.tsx` first and keep its comments' intent.

```ts
"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  initialPreferenceState,
  requestPreference,
  settlePreference,
  skipPreference,
  syncPreference,
} from "@/lib/optimistic-preference";

/**
 * A preference the UI applies at once and saves in the background. Saves run
 * one after another so the database ends on the latest choice; only the
 * latest request may roll the UI back (lib/optimistic-preference.ts).
 * `initial` is the server-rendered value; when it changes (another device, a
 * refresh) the hook follows it unless a save of ours is pending. `apply` runs
 * for every change the page must reflect outside React (e.g. <html> attrs).
 */
export function useOptimisticPreference<T extends string>({
  initial,
  save,
  apply,
  failedMessage,
}: {
  initial: T;
  save: (value: T) => Promise<{ success: boolean }>;
  apply?: (value: T) => void;
  failedMessage: string;
}): [T, (next: T) => void] {
  const [shown, setShown] = React.useState(initial);
  // Reducer state in a ref so callbacks never read a stale render.
  const stateRef = React.useRef(initialPreferenceState(initial));
  const queueRef = React.useRef<Promise<void>>(Promise.resolve());
  const optsRef = React.useRef({ save, apply, failedMessage });
  optsRef.current = { save, apply, failedMessage };

  const show = React.useCallback((value: T) => {
    optsRef.current.apply?.(value);
    setShown(value);
  }, []);

  const set = React.useCallback(
    (requested: T) => {
      const req = requestPreference(stateRef.current, requested);
      if (!req) return;
      stateRef.current = req.state;
      show(requested);

      // The chain never rejects, so one failure cannot stall later saves.
      queueRef.current = queueRef.current
        .then(async () => {
          // A newer pick will save instead; skipping avoids replaying this one.
          if (req.id !== stateRef.current.latest) {
            stateRef.current = skipPreference(stateRef.current);
            return;
          }
          let ok = false;
          try {
            ok = (await optsRef.current.save(requested)).success;
          } catch {
            ok = false;
          }
          const settled = settlePreference(
            stateRef.current,
            req.id,
            requested,
            ok
          );
          stateRef.current = settled.state;
          if (settled.repaint) show(settled.repaint);
          if (settled.toast) toast.error(optsRef.current.failedMessage);
        })
        .catch(() => {});
    },
    [show]
  );

  React.useEffect(() => {
    const next = syncPreference(stateRef.current, initial);
    if (next === stateRef.current) return;
    stateRef.current = next;
    show(initial);
  }, [initial, show]);

  return [shown, set];
}
```

- [ ] **Step 6: Rewrite `components/accent-provider.tsx` on the hook**

Keep `paint`, the context, `useAccent`, and the doc comments. Replace the state/refs/`setAccent`/sync effect with:

```tsx
export function AccentProvider({
  initial,
  children,
}: {
  initial: AccentColor;
  children: React.ReactNode;
}) {
  const t = useTranslations("accentSwitcher");
  const [accent, setAccent] = useOptimisticPreference({
    initial,
    save: setAccentColor,
    apply: paint,
    failedMessage: t("saveFailed"),
  });
  const value = React.useMemo(
    () => ({ accent, setAccent }),
    [accent, setAccent]
  );
  return (
    <AccentContext.Provider value={value}>{children}</AccentContext.Provider>
  );
}
```

Remove the now-unused imports (`toast`, the `@/lib/accent-state` ones); add `import { useOptimisticPreference } from "@/hooks/use-optimistic-preference";`. Note: the first render no longer calls `paint(initial)` — same as before (the server already rendered `data-accent`).

- [ ] **Step 7: Verify nothing else imports the old module**

Run: `grep -rn "accent-state" --include=*.ts --include=*.tsx . | grep -v node_modules`
Expected: no output.

- [ ] **Step 8: Run gates**

Run: `bun test && bunx tsc --noEmit && bunx biome ci .`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add -A lib/optimistic-preference.ts lib/accent-state.ts hooks/use-optimistic-preference.ts components/accent-provider.tsx tests/optimistic-preference.test.ts tests/accent-state.test.ts
git commit -m "refactor(accents): generic latest-wins preference hook"
```

---

### Task 4: Store the preference

**Files:**
- Create: `drizzle/20261014000000_user_motif/migration.sql`
- Modify: `lib/db/schema.ts` (users table, after `accentColor`)
- Modify: `lib/auth.ts` (`additionalFields`)
- Modify: `actions/profile.ts` (after `setAccentColor`)

**Interfaces:**
- Consumes: `motifPreferenceSchema`, `storedMotif`, `MotifPreference` (Task 1).
- Produces: `session.user.motif: string | null | undefined`; `setMotif(input: unknown): Promise<ActionResponse>`.

- [ ] **Step 1: Migration** — `drizzle/20261014000000_user_motif/migration.sql`

```sql
-- Per-user background motif (docs/superpowers/specs/2026-10-14-nusantara-motifs-design.md).
-- Additive and nullable: NULL means "daily rotation", otherwise 'none' or a
-- slug from lib/motifs.ts. The running build ignores the column, so this can
-- be applied before the deploy. No CHECK constraint: the app validates and
-- falls back to daily on unknown values, so adding or removing a motif needs
-- no migration.
BEGIN;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "motif" text;

COMMIT;
```

- [ ] **Step 2: Schema** — in `lib/db/schema.ts`, below `accentColor`:

```ts
    // lib/motifs.ts: 'none' or a motif slug; null = daily rotation
    // (effectiveMotifPreference).
    motif: text("motif").$type<Exclude<MotifPreference, "daily">>(),
```

Add `import type { MotifPreference } from "@/lib/motifs";` next to the existing `AccentColor` type import.

- [ ] **Step 3: Session field** — in `lib/auth.ts` `additionalFields`, after `accentColor`:

```ts
      motif: { type: "string", required: false, input: false },
```

- [ ] **Step 4: Action** — in `actions/profile.ts`, after `setAccentColor`:

```ts
/** Save the caller's background motif. The UI applies it optimistically. */
export async function setMotif(input: unknown): Promise<ActionResponse> {
  const session = await requireSession();
  const t = await getTranslations("actionErrors");
  const parsed = motifPreferenceSchema.safeParse(input);
  if (!parsed.success) return { success: false, message: t("invalidInput") };

  await db
    .update(users)
    .set({ motif: storedMotif(parsed.data), updatedAt: new Date() })
    .where(eq(users.id, session.user.id));

  // The sidebar watermark is rendered by the root layout.
  revalidatePath("/", "layout");
  return { success: true };
}
```

Import `motifPreferenceSchema, storedMotif` from `@/lib/motifs`.

- [ ] **Step 5: Gates**

Run: `bunx tsc --noEmit && bun test && bunx biome ci .`
Expected: pass. (Parsing and storage mapping are covered by Task 1 tests; the action itself is a thin DB write like `setAccentColor`, which has no unit test either.)

- [ ] **Step 6: Commit**

```bash
git add drizzle/20261014000000_user_motif lib/db/schema.ts lib/auth.ts actions/profile.ts
git commit -m "feat(motifs): users.motif column and setMotif action"
```

---

### Task 5: Captions in five languages

**Files:**
- Modify: `messages/en.json`, `messages/id.json`, `messages/es.json`, `messages/zh.json`, `messages/ar.json` — new top-level `motifs` namespace (place it right after `accentSwitcher`)
- Test: `tests/motif-messages.test.ts`

**Interfaces:**
- Consumes: `MOTIF_SLUGS` (Task 1).
- Produces: keys `motifs.label`, `motifs.daily`, `motifs.none`, `motifs.about` (`{name}`), `motifs.localName` (`{name}`), `motifs.source`, `motifs.aiNote`, `motifs.saveFailed`, `motifs.items.<slug>.region|medium|meaning`.

- [ ] **Step 1: Write the failing test** — `tests/motif-messages.test.ts`

```ts
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { routing } from "@/i18n/routing";
import { MOTIF_SLUGS } from "@/lib/motifs";

type Motifs = Record<string, unknown> & {
  items: Record<string, Record<string, string>>;
};

function motifs(locale: string): Motifs {
  return JSON.parse(readFileSync(`messages/${locale}.json`, "utf8")).motifs;
}

const KEYS = ["region", "medium", "meaning"];

describe("motifs messages", () => {
  const en = motifs("en");

  for (const locale of routing.locales) {
    it(`${locale} has every motifs key`, () => {
      const m = motifs(locale);
      expect(Object.keys(m).sort()).toEqual(Object.keys(en).sort());
      expect(Object.keys(m.items).sort()).toEqual([...MOTIF_SLUGS].sort());
      for (const slug of MOTIF_SLUGS) {
        for (const key of KEYS) {
          expect(m.items[slug][key]?.trim().length ?? 0).toBeGreaterThan(0);
        }
      }
      expect(String(m.about)).toContain("{name}");
      expect(String(m.localName)).toContain("{name}");
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/motif-messages.test.ts`
Expected: FAIL — `motifs` is undefined.

- [ ] **Step 3: English** — add to `messages/en.json`:

```json
  "motifs": {
    "label": "Motif",
    "daily": "Daily",
    "none": "None",
    "about": "About {name}…",
    "localName": "Local name: {name}",
    "source": "Source",
    "aiNote": "This illustration is an AI interpretation of the motif, not a reproduction of an artefact.",
    "saveFailed": "Couldn't save the motif.",
    "items": {
      "pintu-aceh": {
        "region": "Aceh",
        "medium": "Gold filigree jewellery and carving",
        "meaning": "Modelled on the Pintô Khôp, the gate Sultan Iskandar Muda built in the palace garden for his queen from Pahang. In 1935 the goldsmith Mahmud Ibrahim turned its outline into the Pinto Aceh brooch, and the motif spread from jewellery to doors and carving. Listed as Indonesian Intangible Cultural Heritage in 2015."
      },
      "gorga": {
        "region": "Batak Toba, North Sumatra",
        "medium": "Carved and painted wood",
        "meaning": "Gorga are the carvings on the gables of Batak Toba houses, painted in red, white and black. This one follows Simeol-eol, whose swaying tendrils stand for joy, health and a long life with many descendants."
      },
      "pucuk-rebung": {
        "region": "Malay and Minangkabau, West Sumatra",
        "medium": "Songket and wood carving",
        "meaning": "Rows of young bamboo shoots along the borders of songket and on Rumah Gadang carvings. The Minang saying behind it — ketek baguno, gadang tapakai, useful when small and put to use when grown — makes it a wish for a life of purpose."
      },
      "megamendung": {
        "region": "Cirebon, West Java",
        "medium": "Hand-drawn batik (batik tulis)",
        "meaning": "Layered rain clouds with pointed tips, from Cirebon's coastal batik tradition with its Chinese influence. Clouds bring the rain that makes the land fertile, so the motif is read as patience, calm and sheltering leadership."
      },
      "kawung": {
        "region": "Java, Yogyakarta",
        "medium": "Batik",
        "meaning": "Four ovals like the fruit of the sugar palm (kawung) meeting at a centre. Once worn only within the palace, it stands for purity and self-control, and for harmony between the self and the universe."
      },
      "batang-garing": {
        "region": "Dayak Ngaju, Central Kalimantan",
        "medium": "Carving and painting",
        "meaning": "The tree of life of the Dayak Ngaju, from the Kaharingan scripture Panaturan, and the emblem of Palangka Raya. Its spear-tip crown points to the upper world and its roots and jar to the underworld: balance between people, nature and God."
      },
      "patra-punggel": {
        "region": "Bali",
        "medium": "Stone and wood carving",
        "meaning": "The curled tip of a young fern frond (liking paku), built from named parts such as batun poh and kuping guling. It runs along Balinese temple gates and houses and is read as harmony and purity in nature."
      },
      "pa-barre-allo": {
        "region": "Toraja, South Sulawesi",
        "medium": "Carved and painted wood",
        "meaning": "A sun with radiating rays, one of the passura' carvings on the walls of a tongkonan house. It expresses the hope for a noble, united family whose descendants become a blessing to others."
      },
      "mamuli": {
        "region": "Sumba, East Nusa Tenggara",
        "medium": "Ikat weaving (hinggi)",
        "meaning": "The Ω-shaped mamuli is a gold ornament exchanged in Sumbanese marriage gifts; woven into hinggi cloth it becomes a motif. It embodies the feminine principle, fertility and life."
      },
      "tenun-tanimbar": {
        "region": "Tanimbar Islands, Maluku",
        "medium": "Ikat weaving (tais)",
        "meaning": "Tanimbar ikat has held a Geographical Indication since 2017. Its main motif is the orchid, for beauty, dignity and perseverance; the small twin arrowheads (tunis) stand for vigilance."
      },
      "ukiran-asmat": {
        "region": "Asmat, South Papua",
        "medium": "Wood carving",
        "meaning": "The shields, canoe prows and ancestor poles carved by the Asmat are known worldwide. Animal forms such as the hornbill and the praying mantis recur in them and carry the presence of the ancestors."
      }
    }
  },
```

- [ ] **Step 4: Indonesian** — add to `messages/id.json`:

```json
  "motifs": {
    "label": "Motif",
    "daily": "Harian",
    "none": "Tanpa motif",
    "about": "Tentang {name}…",
    "localName": "Nama lokal: {name}",
    "source": "Sumber",
    "aiNote": "Ilustrasi ini adalah interpretasi AI atas motifnya, bukan reproduksi artefak.",
    "saveFailed": "Gagal menyimpan motif.",
    "items": {
      "pintu-aceh": {
        "region": "Aceh",
        "medium": "Perhiasan filigri emas dan ukiran",
        "meaning": "Meniru Pintô Khôp, gerbang yang dibangun Sultan Iskandar Muda di taman istana untuk permaisurinya dari Pahang. Pada 1935 pandai emas Mahmud Ibrahim menjadikan bentuknya bros Pinto Aceh, lalu motif ini menyebar dari perhiasan ke pintu dan ukiran. Ditetapkan sebagai Warisan Budaya Takbenda Indonesia pada 2015."
      },
      "gorga": {
        "region": "Batak Toba, Sumatera Utara",
        "medium": "Ukiran kayu berwarna",
        "meaning": "Gorga adalah ukiran pada dinding depan rumah Batak Toba, diwarnai merah, putih, dan hitam. Yang ini mengikuti Simeol-eol, sulur melambai yang melambangkan sukacita, kesehatan, dan umur panjang dengan banyak keturunan."
      },
      "pucuk-rebung": {
        "region": "Melayu dan Minangkabau, Sumatera Barat",
        "medium": "Songket dan ukiran kayu",
        "meaning": "Deretan rebung muda di pinggiran songket dan ukiran Rumah Gadang. Pepatah Minang di baliknya — ketek baguno, gadang tapakai, kecil berguna, besar terpakai — menjadikannya harapan akan hidup yang bermanfaat."
      },
      "megamendung": {
        "region": "Cirebon, Jawa Barat",
        "medium": "Batik tulis",
        "meaning": "Awan hujan berlapis dengan ujung runcing, dari tradisi batik pesisiran Cirebon yang dipengaruhi budaya Tionghoa. Awan membawa hujan yang menyuburkan tanah, sehingga motif ini dimaknai sebagai kesabaran, ketenangan, dan kepemimpinan yang mengayomi."
      },
      "kawung": {
        "region": "Jawa, Yogyakarta",
        "medium": "Batik",
        "meaning": "Empat bentuk lonjong seperti buah aren (kawung) yang bertemu di satu titik. Dahulu hanya dikenakan di lingkungan keraton, motif ini melambangkan kesucian dan pengendalian diri, serta keselarasan antara diri dan semesta."
      },
      "batang-garing": {
        "region": "Dayak Ngaju, Kalimantan Tengah",
        "medium": "Ukiran dan lukisan",
        "meaning": "Pohon kehidupan Dayak Ngaju dari kitab Kaharingan Panaturan, sekaligus lambang Kota Palangka Raya. Pucuknya yang serupa mata tombak menunjuk dunia atas, akar dan gucinya dunia bawah: keseimbangan antara manusia, alam, dan Tuhan."
      },
      "patra-punggel": {
        "region": "Bali",
        "medium": "Ukiran batu dan kayu",
        "meaning": "Ujung pakis muda yang melengkung (liking paku), tersusun dari bagian-bagian bernama seperti batun poh dan kuping guling. Menghiasi gerbang pura dan rumah Bali, motif ini dimaknai sebagai keselarasan dan kesucian alam."
      },
      "pa-barre-allo": {
        "region": "Toraja, Sulawesi Selatan",
        "medium": "Ukiran kayu berwarna",
        "meaning": "Matahari dengan sinar memancar, salah satu ukiran passura' di dinding tongkonan. Motif ini mengungkapkan harapan akan keluarga yang mulia dan bersatu, yang keturunannya menjadi berkat bagi sesama."
      },
      "mamuli": {
        "region": "Sumba, Nusa Tenggara Timur",
        "medium": "Tenun ikat (hinggi)",
        "meaning": "Mamuli berbentuk Ω adalah perhiasan emas yang dipertukarkan dalam adat perkawinan Sumba; ditenun pada kain hinggi, ia menjadi motif. Mamuli melambangkan prinsip feminin, kesuburan, dan kehidupan."
      },
      "tenun-tanimbar": {
        "region": "Kepulauan Tanimbar, Maluku",
        "medium": "Tenun ikat (tais)",
        "meaning": "Tenun ikat Tanimbar memperoleh Indikasi Geografis pada 2017. Motif utamanya bunga anggrek, lambang kecantikan, keagungan, dan keuletan; mata panah kembar kecil (tunis) melambangkan kewaspadaan."
      },
      "ukiran-asmat": {
        "region": "Asmat, Papua Selatan",
        "medium": "Ukiran kayu",
        "meaning": "Perisai, haluan perahu, dan tiang leluhur ukiran suku Asmat dikenal di seluruh dunia. Bentuk hewan seperti burung enggang dan belalang sembah berulang di dalamnya dan menghadirkan para leluhur."
      }
    }
  },
```

- [ ] **Step 5: Spanish, Chinese, Arabic** — add the same structure to `messages/es.json`, `messages/zh.json`, `messages/ar.json`, translating every string from the English above. Rules:
  - Keep `{name}` placeholders exactly.
  - Keep proper nouns and italic-worthy local terms untranslated: Pintô Khôp, Iskandar Muda, Pahang, Mahmud Ibrahim, Pinto Aceh, Batak Toba, Simeol-eol, songket, Rumah Gadang, *ketek baguno, gadang tapakai*, Cirebon, kawung, Dayak Ngaju, Kaharingan, Panaturan, Palangka Raya, liking paku, batun poh, kuping guling, passura', tongkonan, mamuli, hinggi, tais, tunis, Asmat.
  - Translate place descriptors (e.g. "North Sumatra" → es "Sumatra del Norte", zh "北苏门答腊", ar "شمال سومطرة").
  - Look at the existing `accentSwitcher` block in each file for tone (es uses "tú"-free neutral UI register; ar is MSA).

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/motif-messages.test.ts && bunx biome ci .`
Expected: PASS; JSON valid.

- [ ] **Step 7: Commit**

```bash
git add messages tests/motif-messages.test.ts
git commit -m "feat(motifs): cultural captions in five languages"
```

---

### Task 6: Watermark and caption components, outside the app shell

**Files:**
- Create: `components/motif-watermark.tsx`
- Create: `components/motif-info.tsx`
- Modify: `app/[locale]/layout.tsx` (unauthenticated wrapper + footer)

**Interfaces:**
- Consumes: `motifSrc`, `getMotif`, `dailyMotif`, `MotifSlug` (Task 1); `motifs.*` messages (Task 5); `APP_TIMEZONE` (`lib/timezone.ts`).
- Produces:
  - `MotifWatermark({ slug, className }: { slug: MotifSlug; className?: string })` — server-safe, no hooks.
  - `MotifInfo({ slug })`, `MotifInfoPopover({ slug })`, `MotifInfoDialog({ slug, open, onOpenChange })` — client.

- [ ] **Step 1: The watermark** — `components/motif-watermark.tsx`

```tsx
import { type MotifSlug, motifSrc } from "@/lib/motifs";
import { cn } from "@/lib/utils";

/**
 * A faint background ornament. The motif image is only a mask; the colour is
 * the accent's --primary, so it follows the theme and the user's accent
 * without one image per colour. The mask hugs the bottom-right corner of the
 * box — rotate or mirror the box to put it in another corner. Decorative only.
 */
export function MotifWatermark({
  slug,
  className,
}: {
  slug: MotifSlug;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none select-none bg-primary opacity-[0.06] dark:opacity-[0.08] print:hidden forced-colors:hidden",
        className
      )}
      style={{
        maskImage: `url(${motifSrc(slug)})`,
        maskRepeat: "no-repeat",
        maskSize: "contain",
        maskPosition: "bottom right",
      }}
    />
  );
}
```

- [ ] **Step 2: The caption** — `components/motif-info.tsx`

```tsx
"use client";

import { Info } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { getMotif, type MotifSlug } from "@/lib/motifs";

/** A motif's cultural note: origin, local name, meaning, source. */
export function MotifInfo({ slug }: { slug: MotifSlug }) {
  const t = useTranslations("motifs");
  const motif = getMotif(slug);
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-muted-foreground">
        {t(`items.${slug}.region`)} · {t(`items.${slug}.medium`)}
      </p>
      {motif.localName ? (
        <p className="text-muted-foreground">
          {t("localName", { name: motif.localName })}
        </p>
      ) : null}
      <p>{t(`items.${slug}.meaning`)}</p>
      <a
        href={motif.sourceUrl}
        target="_blank"
        rel="noreferrer"
        className="w-fit text-primary underline-offset-4 hover:underline"
      >
        {t("source")}
      </a>
      <p className="text-xs text-muted-foreground">{t("aiNote")}</p>
    </div>
  );
}

/** The footer button outside the app shell: "ⓘ Kawung · Yogyakarta". */
export function MotifInfoPopover({ slug }: { slug: MotifSlug }) {
  const t = useTranslations("motifs");
  const motif = getMotif(slug);
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-xs font-normal text-muted-foreground"
          />
        }
      >
        <Info className="size-3.5" />
        {motif.name}
        <span className="hidden sm:inline">· {t(`items.${slug}.region`)}</span>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80">
        <PopoverHeader>
          <PopoverTitle>{motif.name}</PopoverTitle>
        </PopoverHeader>
        <MotifInfo slug={slug} />
      </PopoverContent>
    </Popover>
  );
}

/** The same note as a dialog, opened from the user menu. */
export function MotifInfoDialog({
  slug,
  open,
  onOpenChange,
}: {
  slug: MotifSlug;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{getMotif(slug).name}</DialogTitle>
        </DialogHeader>
        <MotifInfo slug={slug} />
      </DialogContent>
    </Dialog>
  );
}
```

Check `components/ui/popover.tsx` for `PopoverHeader`/`PopoverTitle` and `components/ui/dialog.tsx` for the `Dialog` props (`open`, `onOpenChange`) before relying on them; adapt to their actual signatures if they differ.

- [ ] **Step 3: Wire the unauthenticated wrapper** — `app/[locale]/layout.tsx`

Near where `accent` is computed (around line 141), add:

```ts
  // Same for everyone on the same WIB day; computed on the server so the
  // first paint already has it.
  const todayMotif = dailyMotif(new Date(), APP_TIMEZONE);
```

Replace the unauthenticated branch's wrapper and footer (the `<div className="flex flex-col min-h-dvh bg-muted dark:bg-background">` block) with:

```tsx
                  <div className="relative isolate flex flex-col min-h-dvh overflow-hidden bg-muted dark:bg-background">
                    {/* Corner ornaments, letterhead-style: the motif hugs the
                        bottom-right, and the same art turned 180° the
                        top-left. Small screens keep only the bottom one. */}
                    <MotifWatermark
                      slug={todayMotif}
                      className="absolute -z-10 bottom-0 right-0 size-[min(70vw,320px)] sm:size-[min(45vw,520px)]"
                    />
                    <MotifWatermark
                      slug={todayMotif}
                      className="absolute -z-10 top-0 left-0 hidden sm:block size-[min(45vw,520px)] rotate-180"
                    />
                    {/* (keep the existing "No `min-h-0`" comment) */}
                    <div className="flex-1 flex flex-col">{children}</div>
                    {/* (keep the existing footer comment) */}
                    <footer className="flex items-center gap-2 px-4 py-4">
                      <div className="flex-1 flex justify-start">
                        <MotifInfoPopover slug={todayMotif} />
                      </div>
                      <Copyright className="shrink-0" />
                      <div className="flex-1 flex justify-end">
                        {/* existing locale/theme pill, unchanged */}
                      </div>
                    </footer>
                  </div>
```

Keep the existing comments and the pill markup verbatim; only the wrapper classes, the two `MotifWatermark`s and the left spacer's contents change. Imports: `MotifWatermark` from `@/components/motif-watermark`, `MotifInfoPopover` from `@/components/motif-info`, `dailyMotif` from `@/lib/motifs`.

- [ ] **Step 4: Gates**

Run: `bunx tsc --noEmit && bunx biome ci . && bun test`
Expected: pass.

- [ ] **Step 5: Visual check (sign-in)**

Start the app against the live DB the usual way (`~/.config/opsdeck-local/run-dev.sh`, or ask the user to) and capture `/en/sign-in` and `/ar/sign-in` in headless Chrome (CDP on 9223), light and dark (toggle with the footer theme button). Expect: two faint corner ornaments in brand blue, card readable, footer shows "ⓘ <motif> · <region>", popover opens upward with the caption. Mobile width 390px: only the bottom-right ornament.

- [ ] **Step 6: Commit**

```bash
git add components/motif-watermark.tsx components/motif-info.tsx "app/[locale]/layout.tsx"
git commit -m "feat(motifs): corner watermark and caption on pages outside the app"
```

---

### Task 7: Sidebar, user menu and command palette

**Files:**
- Create: `components/motif-provider.tsx`
- Modify: `app/[locale]/layout.tsx` (wrap with `MotifProvider`)
- Modify: `components/app-sidebar.tsx`
- Modify: `components/user-menu.tsx`
- Modify: `components/command-palette.tsx`

**Interfaces:**
- Consumes: `useOptimisticPreference` (Task 3); `setMotif` (Task 4); `MotifWatermark`, `MotifInfoDialog` (Task 6); `MOTIFS`, `getMotif`, `resolveMotif`, `effectiveMotifPreference`, `MotifPreference`, `MotifSlug` (Task 1).
- Produces: `MotifProvider({ initial, today, children })`, `useMotif(): { preference: MotifPreference; motif: MotifSlug | null; today: MotifSlug; setPreference: (p: MotifPreference) => void }`.

- [ ] **Step 1: Provider** — `components/motif-provider.tsx`

```tsx
"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { setMotif } from "@/actions/profile";
import { useOptimisticPreference } from "@/hooks/use-optimistic-preference";
import { type MotifPreference, type MotifSlug, resolveMotif } from "@/lib/motifs";

type MotifContextValue = {
  preference: MotifPreference;
  /** What to draw now; null when the user chose none. */
  motif: MotifSlug | null;
  /** Today's rotating motif, computed by the server in APP_TIMEZONE. */
  today: MotifSlug;
  setPreference: (next: MotifPreference) => void;
};

const MotifContext = React.createContext<MotifContextValue | null>(null);

/** The signed-in user's background motif; changes apply at once and save in the background. */
export function MotifProvider({
  initial,
  today,
  children,
}: {
  initial: MotifPreference;
  today: MotifSlug;
  children: React.ReactNode;
}) {
  const t = useTranslations("motifs");
  const [preference, setPreference] = useOptimisticPreference({
    initial,
    save: setMotif,
    failedMessage: t("saveFailed"),
  });
  const value = React.useMemo(
    () => ({
      preference,
      motif: resolveMotif(preference, today),
      today,
      setPreference,
    }),
    [preference, today, setPreference]
  );
  return (
    <MotifContext.Provider value={value}>{children}</MotifContext.Provider>
  );
}

export function useMotif(): MotifContextValue {
  const ctx = React.useContext(MotifContext);
  if (!ctx) throw new Error("useMotif must be used inside MotifProvider");
  return ctx;
}
```

- [ ] **Step 2: Layout** — in `app/[locale]/layout.tsx`, nest `MotifProvider` directly inside `AccentProvider` (so the sidebar, user menu and command palette are all inside it):

```tsx
                  <AccentProvider initial={accent}>
                    <MotifProvider
                      initial={effectiveMotifPreference(session.user)}
                      today={todayMotif}
                    >
                      {/* existing ActiveRunsProvider subtree, unchanged */}
                    </MotifProvider>
                  </AccentProvider>
```

Import `MotifProvider` and `effectiveMotifPreference`.

- [ ] **Step 3: Sidebar** — `components/app-sidebar.tsx`

Add a small component in the same file, above `AppSidebar`:

```tsx
/**
 * The motif in the bottom corner of the menu area. It sits behind the menu
 * (-z-10 inside an isolated wrapper; a positioned layer would otherwise paint
 * over the items), mirrors in RTL where the sidebar is on the right, and is
 * hidden when the sidebar collapses to icons.
 */
function SidebarMotif() {
  const { motif } = useMotif();
  if (!motif) return null;
  return (
    <MotifWatermark
      slug={motif}
      className="absolute inset-x-0 bottom-0 -z-10 aspect-square rtl:-scale-x-100 group-data-[collapsible=icon]:hidden"
    />
  );
}
```

Wrap `<SidebarContent>…</SidebarContent>` so the layer is anchored to the menu area, not the scrolling content, and stays above the footer:

```tsx
      <div className="relative isolate flex min-h-0 flex-1 flex-col">
        <SidebarMotif />
        <SidebarContent>
          {/* existing groups, unchanged */}
        </SidebarContent>
      </div>
```

Imports: `MotifWatermark`, `useMotif`.

- [ ] **Step 4: User menu** — `components/user-menu.tsx`

Add after the Accent `DropdownMenuSub` (before Language):

```tsx
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Shapes />
              {tMotif("label")}
              <CurrentValue>{motifLabel(preference)}</CurrentValue>
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent className="max-h-[min(70vh,34rem)] overflow-y-auto">
                {motif ? (
                  <>
                    <DropdownMenuItem onClick={() => setAboutMotif(true)}>
                      <Info />
                      {tMotif("about", { name: getMotif(motif).name })}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                ) : null}
                <DropdownMenuRadioGroup
                  value={preference}
                  onValueChange={(v) => setPreference(v as MotifPreference)}
                >
                  <DropdownMenuRadioItem value="daily">
                    <MotifOption
                      label={tMotif("daily")}
                      hint={getMotif(today).name}
                    />
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="none">
                    {tMotif("none")}
                  </DropdownMenuRadioItem>
                  <DropdownMenuSeparator />
                  {MOTIFS.map((m) => (
                    <DropdownMenuRadioItem key={m.slug} value={m.slug}>
                      <MotifOption
                        label={m.name}
                        hint={tMotif(`items.${m.slug}.region`)}
                      />
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
```

In the component body:

```tsx
  const tMotif = useTranslations("motifs");
  const { preference, motif, today, setPreference } = useMotif();
  const [aboutMotif, setAboutMotif] = React.useState(false);

  function motifLabel(p: MotifPreference): string {
    if (p === "daily") return tMotif("daily");
    if (p === "none") return tMotif("none");
    return getMotif(p).name;
  }
```

Next to `<StatusDialog …/>` at the end of the fragment:

```tsx
      {motif ? (
        <MotifInfoDialog
          slug={motif}
          open={aboutMotif}
          onOpenChange={setAboutMotif}
        />
      ) : null}
```

Below `CurrentValue` at the bottom of the file:

```tsx
/** A two-line radio label: the option and a muted hint under it. */
function MotifOption({ label, hint }: { label: string; hint: string }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate">{label}</span>
      <span className="truncate text-xs text-muted-foreground">{hint}</span>
    </span>
  );
}
```

Imports: `Info`, `Shapes` from `lucide-react`; `useMotif`; `MotifInfoDialog`; `getMotif`, `MOTIFS`, `type MotifPreference` from `@/lib/motifs`.

- [ ] **Step 5: Command palette** — `components/command-palette.tsx`, after the accent group:

```tsx
          <CommandSeparator />
          <CommandGroup heading={tMotif("label")}>
            <CommandItem
              value="motif daily"
              onSelect={() => run(() => setPreference("daily"))}
            >
              <CalendarDays />
              {tMotif("daily")}
            </CommandItem>
            <CommandItem
              value="motif none"
              onSelect={() => run(() => setPreference("none"))}
            >
              <Ban />
              {tMotif("none")}
            </CommandItem>
            {MOTIFS.map((m) => (
              <CommandItem
                key={m.slug}
                value={`motif ${m.name} ${tMotif(`items.${m.slug}.region`)}`}
                onSelect={() => run(() => setPreference(m.slug))}
              >
                <Shapes />
                {m.name}
                <span className="ms-auto text-xs text-muted-foreground">
                  {tMotif(`items.${m.slug}.region`)}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
```

With `const tMotif = useTranslations("motifs");` and `const { setPreference } = useMotif();` beside the accent ones. Imports: `Ban`, `CalendarDays`, `Shapes`; `useMotif`; `MOTIFS`.

- [ ] **Step 6: Gates**

Run: `bunx tsc --noEmit && bunx biome ci . && bun test && bun run build; echo "build exit $?"`
Expected: all pass, `build exit 0`.

- [ ] **Step 7: Commit**

```bash
git add components/motif-provider.tsx components/app-sidebar.tsx components/user-menu.tsx components/command-palette.tsx "app/[locale]/layout.tsx"
git commit -m "feat(motifs): sidebar watermark, motif picker and palette entries"
```

---

### Task 8: Docs, visual QA and opacity tuning

**Files:**
- Modify: `README.md` (after the "Brand and accent colour" section)
- Possibly modify: `components/motif-watermark.tsx` (opacity values only)

- [ ] **Step 1: README** — add a section:

```markdown
### Background motifs

Faint Nusantara ornaments sit in the corners of the pages outside the app (sign-in, setup, password reset, invitations, errors) and at the bottom of the sidebar. There are eleven, one per major region, ordered west to east: Pintu Aceh, Gorga, Pucuk Rebung, Megamendung, Kawung, Batang Garing, Patra Punggel, Pa' Barre Allo, Mamuli, Tenun Tanimbar and Ukiran Asmat. Everyone sees the same motif each day (it changes at midnight `APP_TIMEZONE`); each user can pin one or turn them off from the user menu (**Motif**) or the command palette, stored in `users.motif`. The ⓘ button outside the app and **About …** in the menu show a short cultural note.

The images are masks: `components/motif-watermark.tsx` paints `--primary` through them, so they follow the theme and accent. The source art in `design/motifs/` was generated with `gpt-image-2.5-sunburst` (prompts in `design/motifs/prompts.json`).

To add or replace a motif:
1. Put a black-on-transparent PNG at `design/motifs/<slug>.png` and run `node scripts/build-motifs.mjs`.
2. For a new motif, add it to `MOTIFS` in `lib/motifs.ts` at its place by longitude.
3. Add its `items.<slug>` caption to `motifs` in all five `messages/*.json` files.
```

- [ ] **Step 2: Visual QA matrix**

With the dev server running against the live DB and a signed-in session, capture in headless Chrome (CDP 9223), 1440×900:

| Page | Theme | Accent | Locale |
|---|---|---|---|
| `/en/sign-in` | light, dark | (brand blue) | en |
| `/ar/sign-in` | light | (brand blue) | ar |
| `/en` (home) | light, dark | blue, rose, neutral | en |
| `/ar` (home) | dark | violet | ar |

Plus 390×844 for `/en/sign-in` and the home page with the sidebar sheet open.

Check:
- Ornaments are noticeable but never compete with text. Tune `opacity-[0.06] dark:opacity-[0.08]` in one place if needed, and note the final values in the commit message.
- Sidebar ornament sits behind the menu items (items readable, hover states unaffected), above the user menu, hugging the same edge in RTL.
- Collapsing the sidebar to icons hides it.
- Switching the motif or accent in the user menu repaints the sidebar at once. "Tanpa motif"/"None" removes it and hides "About …".
- The palette finds motifs by name and region (try "bali", "kawung").

- [ ] **Step 3: Full gates**

Run: `bunx biome ci . && bunx tsc --noEmit && bun test && bun run build; echo "build exit $?"`
Expected: clean, `build exit 0`.

- [ ] **Step 4: Commit**

```bash
git add README.md components/motif-watermark.tsx
git commit -m "docs(motifs): background motifs in README"
```

---

## Rollout (after the branch is merged — needs the user's go-ahead)

1. Backup live: `ssh root@192.168.56.113 'mkdir -p /root/backups; docker exec opsdeck-postgres pg_dump -U postgres -Fc -d dss_panel > /root/backups/dss_panel_pre_user_motif_<ts>.dump'`, verify with `pg_restore -l` inside the container, `scp` to `~/backups/opsdeck/`, compare md5.
2. Dry-run: pipe the migration with `COMMIT` replaced by `ROLLBACK` into `psql -v ON_ERROR_STOP=1`.
3. Apply the migration as-is.
4. Push `main`; the user runs Jenkins `dss-panel`.
5. Remind the user to rotate the OpenAI API key used for the art.
