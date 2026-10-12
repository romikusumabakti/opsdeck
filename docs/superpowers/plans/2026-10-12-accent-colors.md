# Accent Colours Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-picked DSS colours with Tailwind palette steps, and let every user pick an accent colour (shadcn's seven colour themes plus neutral) that follows them across devices and recolours the UI, logo and favicon.

**Architecture:**
- A `data-accent` attribute on `<html>` comes from the user's stored choice, or the brand default when unset. Static CSS in `app/globals.css` binds each colour's Tailwind steps to `--tint-*` variables, and two role blocks map those to the shadcn tokens.
- The choice lives in a new nullable `users.accent_color` column, exposed on `session.user` through better-auth `additionalFields`.
- The logo reads `--logo` / `--logo-status`. The favicon route takes `?accent=` and draws with oklch values kept in TS and checked against Tailwind's palette by a test.

**Tech Stack:** Next.js 16 (App Router; read `node_modules/next/dist/docs/` before touching Next APIs, see AGENTS.md), React 19, Tailwind CSS 4.3, shadcn/ui, next-intl, better-auth 1.7, Drizzle ORM + Postgres, zod 4, Bun 1.4 (`bun test`), Biome.

**Spec:** `docs/superpowers/specs/2026-10-12-accent-colors-design.md`

## Global Constraints

- Accents are exactly `neutral blue green orange red rose violet yellow`. Brand defaults: `default` → `neutral`, `dss` → `blue`.
- Primary step: **900** in light mode, **300** in dark mode, for every colour. Primary foreground: `oklch(1 0 0)` in light, `oklch(0.145 0 0)` in dark.
- Ring steps, light/dark: blue 500/400, green **600**/400, orange **600**/400, red 500/400, rose 500/400, violet 500/400, yellow **700**/400.
- Sidebar accent: light 100 bg with 900 text; dark 950 bg with 200 text. Logo: light 900 + ring-light; dark 200 + ring-dark.
- Neutrals (background, card, border, muted, and so on), destructive/success, charts, radius and fonts stay stock shadcn. The `[data-brand="dss"]` token blocks are deleted.
- Contrast: text pairs ≥ 4.5:1 and the ring against the background ≥ 3:1 (WCAG 1.4.11), enforced by `tests/accent-theme.test.ts`.
- Every new or changed string goes into all of `messages/{ar,en,es,id,zh}.json`.
- `users.accent_color` is `text NULL`, with no CHECK constraint and no backfill. Unknown stored values fall back to the brand default silently.
- Migration `drizzle/20261012000000_accent_color/migration.sql` is applied by hand to the live DB **before** the deploy, after a backup and a dry-run, and only with the user's go-ahead.
- Never add `Co-Authored-By: Claude` or any Claude attribution to commits. Commit messages are conventional (`feat(scope): …`), in English.
- Gates before claiming done: `bun run biome ci .`, `bunx tsc --noEmit --incremental false` (the incremental cache can hide errors), `bun test`, and `bun run build`, where the **exit code** must be 0, not just a tail that looks fine.

## Review Focus

- **A stored accent that is not in `ACCENTS`** (hand-edited row, or a colour removed later) must render the brand default, never crash or leave `data-accent` empty. Pinned in Task 1 (`effectiveAccent`) and Task 3 (route with an unknown `?accent=`).
- **`?accent=` missing, empty, or junk on `/brand/icon.svg`** (404 and error pages, old cached HTML) must return the brand default icon with status 200. Pinned in Task 3.
- **Choosing a colour while the save fails** (session expired, network down) must restore the previous colour and favicon and show a toast, not leave the UI showing an unsaved colour. Pinned in Task 5 by a unit test of the pure `nextAccentState` helper.
- **Light and dark switching after an accent is chosen** must keep every text pair readable. Both modes are pinned for every colour in Task 2.
- **A Tailwind upgrade shifting palette values** must fail CI rather than let the favicon drift from the UI. Pinned in Task 1 (`accent-palette.test.ts`) and Task 2 (bindings match `ACCENT_STEPS`).

---

### Task 1: Accent model and palette constants

**Files:**
- Create: `lib/accents.ts`
- Create: `lib/accent-palette.ts`
- Test: `tests/accents.test.ts`
- Test: `tests/accent-palette.test.ts`

**Interfaces:**
- Consumes: `BRAND_ICON_SRC`, `brand()`, `type BrandName` from `lib/branding.ts` (existing).
- Produces:
  - `ACCENTS`, `type AccentColor`, `accentSchema` (zod enum);
  - `BRAND_DEFAULT_ACCENT`, `isAccent(v: unknown): v is AccentColor`, `defaultAccent(): AccentColor`;
  - `effectiveAccent(user: { accentColor?: string | null } | null | undefined): AccentColor`;
  - `brandIconSrc(accent?: AccentColor): string`;
  - `type TintedAccent = Exclude<AccentColor, "neutral">`;
  - `ACCENT_STEPS: Record<TintedAccent, { logoLight: number; logoDark: number; ringLight: number; ringDark: number }>`;
  - `ACCENT_PALETTE: Record<TintedAccent, { logoLight: string; logoDark: string; ringLight: string; ringDark: string }>`.

- [ ] **Step 1: Write the failing tests**

`tests/accents.test.ts`:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import {
  ACCENTS,
  accentSchema,
  brandIconSrc,
  defaultAccent,
  effectiveAccent,
  isAccent,
} from "@/lib/accents";

const saved = process.env.BRAND;
afterEach(() => {
  if (saved === undefined) delete process.env.BRAND;
  else process.env.BRAND = saved;
});

describe("accents", () => {
  it("lists neutral plus shadcn's seven colour themes", () => {
    expect([...ACCENTS]).toEqual([
      "neutral",
      "blue",
      "green",
      "orange",
      "red",
      "rose",
      "violet",
      "yellow",
    ]);
  });

  it("defaults to the brand's accent", () => {
    process.env.BRAND = "dss";
    expect(defaultAccent()).toBe("blue");
    delete process.env.BRAND;
    expect(defaultAccent()).toBe("neutral");
  });

  it("uses a valid stored accent", () => {
    process.env.BRAND = "dss";
    expect(effectiveAccent({ accentColor: "rose" })).toBe("rose");
    expect(effectiveAccent({ accentColor: "neutral" })).toBe("neutral");
  });

  it("falls back to the brand default for null, missing or unknown values", () => {
    process.env.BRAND = "dss";
    expect(effectiveAccent({ accentColor: null })).toBe("blue");
    expect(effectiveAccent({})).toBe("blue");
    expect(effectiveAccent(null)).toBe("blue");
    expect(effectiveAccent({ accentColor: "teal" })).toBe("blue");
    expect(effectiveAccent({ accentColor: "" })).toBe("blue");
  });

  it("validates input to the closed set", () => {
    expect(accentSchema.safeParse("violet").success).toBe(true);
    expect(accentSchema.safeParse("teal").success).toBe(false);
    expect(accentSchema.safeParse(null).success).toBe(false);
    expect(isAccent("blue")).toBe(true);
    expect(isAccent(42)).toBe(false);
  });

  it("builds the favicon URL, with no param meaning the brand default", () => {
    expect(brandIconSrc("rose")).toBe("/brand/icon.svg?accent=rose");
    expect(brandIconSrc()).toBe("/brand/icon.svg");
  });
});
```

`tests/accent-palette.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACCENT_PALETTE, ACCENT_STEPS } from "@/lib/accent-palette";

// The favicon can't read CSS variables, so lib/accent-palette.ts copies the
// Tailwind values it needs. This pins the copy to the installed palette: a
// Tailwind upgrade that shifts a colour fails here instead of drifting.
const theme = readFileSync(
  join(import.meta.dir, "../node_modules/tailwindcss/theme.css"),
  "utf8"
);

function tailwind(name: string): string {
  const match = theme.match(new RegExp(`--color-${name}: (oklch\\([^)]+\\));`));
  if (!match?.[1]) throw new Error(`--color-${name} not in tailwindcss/theme.css`);
  return match[1];
}

describe("ACCENT_PALETTE", () => {
  for (const [accent, steps] of Object.entries(ACCENT_STEPS)) {
    it(`${accent} matches the Tailwind palette`, () => {
      const values = ACCENT_PALETTE[accent as keyof typeof ACCENT_PALETTE];
      for (const key of Object.keys(steps) as (keyof typeof steps)[]) {
        expect(values[key]).toBe(tailwind(`${accent}-${steps[key]}`));
      }
    });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/accents.test.ts tests/accent-palette.test.ts`
Expected: FAIL with `Cannot find module '@/lib/accents'` and `Cannot find module '@/lib/accent-palette'`.

- [ ] **Step 3: Implement `lib/accents.ts`**

```ts
import { z } from "zod";
import { BRAND_ICON_SRC, type BrandName, brand } from "@/lib/branding";

/**
 * Accent colours a user can pick: shadcn/ui's seven colour themes plus
 * `neutral` (the stock black/white tokens). The choice is stored per user in
 * `users.accent_color`, set on <html data-accent> by the root layout, and
 * mapped to Tailwind palette steps in app/globals.css.
 */
export const ACCENTS = [
  "neutral",
  "blue",
  "green",
  "orange",
  "red",
  "rose",
  "violet",
  "yellow",
] as const;
export type AccentColor = (typeof ACCENTS)[number];

export const accentSchema = z.enum(ACCENTS);

/** What a user gets until they choose: the brand's own colour. */
export const BRAND_DEFAULT_ACCENT: Record<BrandName, AccentColor> = {
  default: "neutral",
  dss: "blue",
};

export function isAccent(value: unknown): value is AccentColor {
  return (
    typeof value === "string" && (ACCENTS as readonly string[]).includes(value)
  );
}

export function defaultAccent(): AccentColor {
  return BRAND_DEFAULT_ACCENT[brand()];
}

/**
 * The accent to render for `user`. An unset or unknown stored value (a hand
 * edit, or a colour removed later) falls back to the brand default rather than
 * failing, like effectiveTimeZone does for zones.
 */
export function effectiveAccent(
  user: { accentColor?: string | null } | null | undefined
): AccentColor {
  const stored = user?.accentColor;
  return isAccent(stored) ? stored : defaultAccent();
}

/** Favicon URL for `accent`; no accent lets the route use the brand default. */
export function brandIconSrc(accent?: AccentColor): string {
  return accent ? `${BRAND_ICON_SRC}?accent=${accent}` : BRAND_ICON_SRC;
}
```

- [ ] **Step 4: Implement `lib/accent-palette.ts`**

```ts
import type { AccentColor } from "@/lib/accents";

export type TintedAccent = Exclude<AccentColor, "neutral">;
type Steps = {
  logoLight: number;
  logoDark: number;
  ringLight: number;
  ringDark: number;
};

/**
 * Tailwind steps per accent for the logo and focus ring. Logo: 900 light, 200
 * dark. Ring: 500 light and 400 dark, except where that falls below 3:1
 * against the page background (WCAG 1.4.11): green and orange use 600, yellow
 * 700. app/globals.css binds the same steps; tests/accent-theme.test.ts checks
 * both agree.
 */
export const ACCENT_STEPS: Record<TintedAccent, Steps> = {
  blue: { logoLight: 900, logoDark: 200, ringLight: 500, ringDark: 400 },
  green: { logoLight: 900, logoDark: 200, ringLight: 600, ringDark: 400 },
  orange: { logoLight: 900, logoDark: 200, ringLight: 600, ringDark: 400 },
  red: { logoLight: 900, logoDark: 200, ringLight: 500, ringDark: 400 },
  rose: { logoLight: 900, logoDark: 200, ringLight: 500, ringDark: 400 },
  violet: { logoLight: 900, logoDark: 200, ringLight: 500, ringDark: 400 },
  yellow: { logoLight: 900, logoDark: 200, ringLight: 700, ringDark: 400 },
};

/**
 * The oklch values of ACCENT_STEPS, copied from tailwindcss/theme.css for the
 * favicon (which cannot read the page's CSS variables). Kept in sync by
 * tests/accent-palette.test.ts.
 */
export const ACCENT_PALETTE: Record<TintedAccent, Record<keyof Steps, string>> = {
  blue: {
    logoLight: "oklch(37.9% 0.146 265.522)",
    logoDark: "oklch(88.2% 0.059 254.128)",
    ringLight: "oklch(62.3% 0.214 259.815)",
    ringDark: "oklch(70.7% 0.165 254.624)",
  },
  green: {
    logoLight: "oklch(39.3% 0.095 152.535)",
    logoDark: "oklch(92.5% 0.084 155.995)",
    ringLight: "oklch(62.7% 0.194 149.214)",
    ringDark: "oklch(79.2% 0.209 151.711)",
  },
  orange: {
    logoLight: "oklch(40.8% 0.123 38.172)",
    logoDark: "oklch(90.1% 0.076 70.697)",
    ringLight: "oklch(64.6% 0.222 41.116)",
    ringDark: "oklch(75% 0.183 55.934)",
  },
  red: {
    logoLight: "oklch(39.6% 0.141 25.723)",
    logoDark: "oklch(88.5% 0.062 18.334)",
    ringLight: "oklch(63.7% 0.237 25.331)",
    ringDark: "oklch(70.4% 0.191 22.216)",
  },
  rose: {
    logoLight: "oklch(41% 0.159 10.272)",
    logoDark: "oklch(89.2% 0.058 10.001)",
    ringLight: "oklch(64.5% 0.246 16.439)",
    ringDark: "oklch(71.2% 0.194 13.428)",
  },
  violet: {
    logoLight: "oklch(38% 0.189 293.745)",
    logoDark: "oklch(89.4% 0.057 293.283)",
    ringLight: "oklch(60.6% 0.25 292.717)",
    ringDark: "oklch(70.2% 0.183 293.541)",
  },
  yellow: {
    logoLight: "oklch(42.1% 0.095 57.708)",
    logoDark: "oklch(94.5% 0.129 101.54)",
    ringLight: "oklch(55.4% 0.135 66.442)",
    ringDark: "oklch(85.2% 0.199 91.936)",
  },
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/accents.test.ts tests/accent-palette.test.ts`
Expected: PASS (6 + 7 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/accents.ts lib/accent-palette.ts tests/accents.test.ts tests/accent-palette.test.ts
git commit -m "feat(accents): accent model and Tailwind palette constants"
```

---

### Task 2: Theme tokens per accent

**Files:**
- Modify: `app/globals.css`. Delete the comment block starting `/* Brand themes.` and the two `[data-brand="dss"]` / `.dark[data-brand="dss"]` blocks (currently around lines 119–180). Add `--logo` / `--logo-status` to the existing `:root` block, and the accent blocks below where the brand blocks were.
- Delete: `tests/brand-theme.test.ts`
- Test: `tests/accent-theme.test.ts`

**Interfaces:**
- Consumes: `ACCENTS` (Task 1), `ACCENT_STEPS` (Task 1).
- Produces: CSS custom properties `--logo` and `--logo-status` (used by Task 3), selected by `<html data-accent="…">` (set in Task 4).

- [ ] **Step 1: Write the failing test** at `tests/accent-theme.test.ts`

```ts
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACCENT_STEPS, type TintedAccent } from "@/lib/accent-palette";
import { ACCENTS } from "@/lib/accents";

// Every accent must keep text readable (WCAG AA 4.5:1) and its focus ring
// visible against the page (WCAG 1.4.11, 3:1) in both modes. Reads the real
// app/globals.css and resolves var(--color-*) from the installed Tailwind
// palette, so the numbers are the ones a browser renders.

const css = readFileSync(join(import.meta.dir, "../app/globals.css"), "utf8");
const theme = readFileSync(
  join(import.meta.dir, "../node_modules/tailwindcss/theme.css"),
  "utf8"
);

function block(selector: string): Record<string, string> | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  const body = match?.[1];
  if (body === undefined) return undefined;
  const tokens: Record<string, string> = {};
  for (const [, name = "", value = ""] of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    tokens[name] = value.trim();
  }
  return tokens;
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} not found`);
  return value;
}

const ROOT = must(block(":root"), ":root block");
const DARK = must(block(".dark"), ".dark block");
const ROLE_LIGHT = must(
  block('[data-accent]:not([data-accent="neutral"]):not(.dark)'),
  "light role block"
);
const ROLE_DARK = must(
  block('.dark[data-accent]:not([data-accent="neutral"])'),
  "dark role block"
);

/** Resolve var() chains against the scopes, then the Tailwind palette. */
function resolve(value: string, scopes: Record<string, string>[]): string {
  const ref = value.match(/^var\(--([\w-]+)\)$/);
  if (!ref?.[1]) return value;
  const name = ref[1];
  for (const scope of scopes) {
    if (scope[name] !== undefined) return resolve(scope[name], scopes);
  }
  const tw = theme.match(new RegExp(`--${name}: (oklch\\([^)]+\\));`));
  return must(tw?.[1], `--${name}`);
}

/** Relative luminance of an opaque oklch() colour (L as 0–1 or a percentage). */
function luminance(value: string): number {
  const m = value.match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/);
  if (!m?.[1] || !m[3] || !m[4]) throw new Error(`not an opaque oklch(): ${value}`);
  const L = Number(m[1]) / (m[2] === "%" ? 100 : 1);
  const C = Number(m[3]);
  const H = (Number(m[4]) * Math.PI) / 180;
  const a = C * Math.cos(H);
  const b = C * Math.sin(H);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clip = (v: number) => Math.min(1, Math.max(0, v));
  return (
    0.2126 * clip(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s) +
    0.7152 * clip(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s) +
    0.0722 * clip(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s)
  );
}

function contrast(x: string, y: string): number {
  const [a, b] = [luminance(x), luminance(y)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const TINTED = ACCENTS.filter((a) => a !== "neutral") as TintedAccent[];

describe("accent themes", () => {
  it("bind every coloured accent and leave neutral stock", () => {
    for (const accent of TINTED) {
      expect(block(`[data-accent="${accent}"]`)).toBeDefined();
    }
    expect(block('[data-accent="neutral"]')).toBeUndefined();
  });

  it("bind the ring steps lib/accent-palette.ts uses for the favicon", () => {
    for (const accent of TINTED) {
      const binding = must(block(`[data-accent="${accent}"]`), accent);
      const steps = ACCENT_STEPS[accent];
      expect(binding["tint-ring-light"]).toBe(`var(--color-${accent}-${steps.ringLight})`);
      expect(binding["tint-ring-dark"]).toBe(`var(--color-${accent}-${steps.ringDark})`);
    }
  });

  for (const accent of TINTED) {
    for (const mode of ["light", "dark"] as const) {
      it(`${accent} (${mode}) keeps text at AA and the ring at 3:1`, () => {
        const binding = must(block(`[data-accent="${accent}"]`), accent);
        const scopes =
          mode === "light" ? [ROLE_LIGHT, binding, ROOT] : [ROLE_DARK, binding, DARK, ROOT];
        const token = (name: string) => resolve(`var(--${name})`, scopes);
        const results = {
          "primary-foreground on primary": contrast(token("primary-foreground"), token("primary")),
          "sidebar-accent-foreground on sidebar-accent": contrast(
            token("sidebar-accent-foreground"),
            token("sidebar-accent")
          ),
        };
        for (const [pair, ratio] of Object.entries(results)) {
          expect({ pair, ok: ratio >= 4.5 }).toEqual({ pair, ok: true });
        }
        const ring = contrast(token("ring"), token("background"));
        expect({ ring: ring >= 3 }).toEqual({ ring: true });
      });
    }
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/accent-theme.test.ts`
Expected: FAIL with `light role block not found`.

- [ ] **Step 3: Edit `app/globals.css`**

1. In the existing `:root { … }` block, add these two lines just before its closing `}`:

```css
  /* Logo colours (components/brand-mark.tsx). Neutral is black/white;
     coloured accents override both in the role blocks below. */
  --logo: var(--foreground);
  --logo-status: color-mix(in oklab, var(--foreground) 40%, transparent);
```

2. Delete the whole brand-theme section: the comment starting `/* Brand themes. The root layout sets data-brand…`, the comment `/* DSS Consulting: navy #203864 accents…`, and both `[data-brand="dss"]:not(.dark) { … }` and `.dark[data-brand="dss"] { … }` blocks.

3. In their place, insert:

```css
/* Accent colours. The root layout sets data-accent on <html> from the user's
   choice (lib/accents.ts), falling back to the brand default. Each colour
   binds its Tailwind steps to --tint-*; the two role blocks then map those to
   the shadcn tokens for every colour except neutral, which stays stock.
   Steps: primary 900 light / 300 dark; ring 500 / 400 unless that falls
   below 3:1 against the page (green and orange 600, yellow 700 in light).
   lib/accent-palette.ts mirrors these for the favicon, and
   tests/accent-theme.test.ts checks contrast and that both agree. */
[data-accent="blue"] {
  --tint-100: var(--color-blue-100);
  --tint-200: var(--color-blue-200);
  --tint-300: var(--color-blue-300);
  --tint-900: var(--color-blue-900);
  --tint-950: var(--color-blue-950);
  --tint-ring-light: var(--color-blue-500);
  --tint-ring-dark: var(--color-blue-400);
}
[data-accent="green"] {
  --tint-100: var(--color-green-100);
  --tint-200: var(--color-green-200);
  --tint-300: var(--color-green-300);
  --tint-900: var(--color-green-900);
  --tint-950: var(--color-green-950);
  --tint-ring-light: var(--color-green-600);
  --tint-ring-dark: var(--color-green-400);
}
[data-accent="orange"] {
  --tint-100: var(--color-orange-100);
  --tint-200: var(--color-orange-200);
  --tint-300: var(--color-orange-300);
  --tint-900: var(--color-orange-900);
  --tint-950: var(--color-orange-950);
  --tint-ring-light: var(--color-orange-600);
  --tint-ring-dark: var(--color-orange-400);
}
[data-accent="red"] {
  --tint-100: var(--color-red-100);
  --tint-200: var(--color-red-200);
  --tint-300: var(--color-red-300);
  --tint-900: var(--color-red-900);
  --tint-950: var(--color-red-950);
  --tint-ring-light: var(--color-red-500);
  --tint-ring-dark: var(--color-red-400);
}
[data-accent="rose"] {
  --tint-100: var(--color-rose-100);
  --tint-200: var(--color-rose-200);
  --tint-300: var(--color-rose-300);
  --tint-900: var(--color-rose-900);
  --tint-950: var(--color-rose-950);
  --tint-ring-light: var(--color-rose-500);
  --tint-ring-dark: var(--color-rose-400);
}
[data-accent="violet"] {
  --tint-100: var(--color-violet-100);
  --tint-200: var(--color-violet-200);
  --tint-300: var(--color-violet-300);
  --tint-900: var(--color-violet-900);
  --tint-950: var(--color-violet-950);
  --tint-ring-light: var(--color-violet-500);
  --tint-ring-dark: var(--color-violet-400);
}
[data-accent="yellow"] {
  --tint-100: var(--color-yellow-100);
  --tint-200: var(--color-yellow-200);
  --tint-300: var(--color-yellow-300);
  --tint-900: var(--color-yellow-900);
  --tint-950: var(--color-yellow-950);
  --tint-ring-light: var(--color-yellow-700);
  --tint-ring-dark: var(--color-yellow-400);
}

[data-accent]:not([data-accent="neutral"]):not(.dark) {
  --primary: var(--tint-900);
  --primary-foreground: oklch(1 0 0);
  --ring: var(--tint-ring-light);
  --sidebar-primary: var(--tint-900);
  --sidebar-primary-foreground: oklch(1 0 0);
  --sidebar-accent: var(--tint-100);
  --sidebar-accent-foreground: var(--tint-900);
  --sidebar-ring: var(--tint-ring-light);
  --logo: var(--tint-900);
  --logo-status: var(--tint-ring-light);
}

.dark[data-accent]:not([data-accent="neutral"]) {
  --primary: var(--tint-300);
  --primary-foreground: oklch(0.145 0 0);
  --ring: var(--tint-ring-dark);
  --sidebar-primary: var(--tint-300);
  --sidebar-primary-foreground: oklch(0.145 0 0);
  --sidebar-accent: var(--tint-950);
  --sidebar-accent-foreground: var(--tint-200);
  --sidebar-ring: var(--tint-ring-dark);
  --logo: var(--tint-200);
  --logo-status: var(--tint-ring-dark);
}
```

4. Delete `tests/brand-theme.test.ts`. Its subject (the `[data-brand]` blocks) no longer exists.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/accent-theme.test.ts`
Expected: PASS (2 + 14 tests).

- [ ] **Step 5: Commit**

```bash
git rm tests/brand-theme.test.ts
git add app/globals.css tests/accent-theme.test.ts
git commit -m "feat(theme): accent token blocks from the Tailwind palette, stock neutrals"
```

---

### Task 3: Logo and favicon follow the accent

**Files:**
- Modify: `lib/brand-logos.ts` (drop per-brand colours; `renderBrandIcon` takes the accent)
- Modify: `components/brand-mark.tsx` (fill from `--logo` / `--logo-status`)
- Modify: `app/brand/icon.svg/route.ts` (read `?accent=`)
- Modify: `lib/branding.ts` (doc comment on `BRANDS` only)
- Test: `tests/brand-icon.test.ts` (rewrite)

**Interfaces:**
- Consumes: `isAccent`, `defaultAccent`, `type AccentColor` (Task 1); `ACCENT_PALETTE` (Task 1); `--logo` / `--logo-status` (Task 2).
- Produces:
  - `renderBrandIcon(logo: BrandName, accent: AccentColor): string`;
  - `GET(request: Request): Response`;
  - `BrandLogo({ logo, active?, className? })`, unchanged props.

- [ ] **Step 1: Rewrite the failing test** `tests/brand-icon.test.ts`

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { GET } from "@/app/brand/icon.svg/route";

const saved = process.env.BRAND;
afterEach(() => {
  if (saved === undefined) delete process.env.BRAND;
  else process.env.BRAND = saved;
});

async function fetchIcon(query: string, brand?: string) {
  if (brand === undefined) delete process.env.BRAND;
  else process.env.BRAND = brand;
  const res = GET(new Request(`http://localhost/brand/icon.svg${query}`));
  return { res, body: await res.text() };
}

describe("GET /brand/icon.svg", () => {
  it("serves a cacheable SVG", async () => {
    const { res, body } = await fetchIcon("?accent=blue", "dss");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("cache-control")).toStartWith("public");
    expect(body).toStartWith("<svg");
  });

  it("colours the mark with the requested accent", async () => {
    const { body } = await fetchIcon("?accent=rose", "dss");
    expect(body).toContain("oklch(41% 0.159 10.272)"); // rose-900
    expect(body).toContain("oklch(89.2% 0.058 10.001)"); // rose-200
  });

  it("uses the brand default for a missing, empty or unknown accent", async () => {
    for (const query of ["", "?accent=", "?accent=teal", "?accent=%3Cscript%3E"]) {
      const { res, body } = await fetchIcon(query, "dss");
      expect(res.status).toBe(200);
      expect(body).toContain("oklch(37.9% 0.146 265.522)"); // blue-900
    }
  });

  it("draws neutral in black and white", async () => {
    const { body } = await fetchIcon("?accent=neutral", "dss");
    expect(body).toContain("#171717");
    expect(body).toContain("#fafafa");
    expect(body).not.toContain("oklch(");
  });

  it("keeps the brand's shape whatever the accent", async () => {
    const dss = (await fetchIcon("?accent=neutral", "dss")).body;
    const plain = (await fetchIcon("?accent=neutral")).body;
    expect(dss).not.toBe(plain);
  });

  it("adapts to the browser's colour scheme, since it can't see the app theme", async () => {
    for (const accent of ["neutral", "blue", "yellow"]) {
      const { body } = await fetchIcon(`?accent=${accent}`, "dss");
      expect(body).toContain("prefers-color-scheme: dark");
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/brand-icon.test.ts`
Expected: FAIL. `GET` ignores the request, so the rose/blue oklch expectations fail.

- [ ] **Step 3: Update `lib/brand-logos.ts`**

1. Replace the header comment's first paragraph and the `Colors` / `LogoDef` types:

```ts
import { ACCENT_PALETTE } from "@/lib/accent-palette";
import type { AccentColor } from "@/lib/accents";
import type { BrandName } from "@/lib/branding";

/**
 * Logo shapes per brand (BRAND). Every logo is the same four-tile grid — top-
 * left, top-right, bottom-left, and the bottom-right "status" tile that
 * animates while runs are active — so the motion in globals.css works for all
 * of them and only the shape differs. Colour comes from the user's accent:
 * --logo / --logo-status in the app, ACCENT_PALETTE for the favicon.
 *
 * Geometry is drawn twice, each on a whole-pixel grid for the sizes it is shown
 * at, so no edge lands on half a pixel and blurs:
 *   - 24 units (tile 10, gap 4) for the in-app logo, rendered at 24px;
 *   - 16 units (tile 7, gap 2) for the favicon, shown at 16 and 32px.
 */

type Tiles = { tl: string; tr: string; bl: string; br: string };
type Colors = { fg: string; status: string };

type LogoDef = { tiles: (unit: Grid) => Tiles };
```

2. Replace `BRAND_LOGO_DEFS`:

```ts
export const BRAND_LOGO_DEFS: Record<BrandName, LogoDef> = {
  // Neutral product mark: a plain dashboard grid.
  default: { tiles: (g) => grid(g, { tr: g.radius, br: g.radius }) },
  // DSS Panel: the right-hand tiles round their outer corners into a "D".
  dss: {
    tiles: (g) => grid(g, { tr: g.tile - g.radius, br: g.tile - g.radius }),
  },
};
```

3. Replace `renderBrandIcon` and add the colour helper above it:

```ts
const NEUTRAL_ICON: { light: Colors; dark: Colors } = {
  light: { fg: "#171717", status: "rgba(23,23,23,.4)" },
  dark: { fg: "#fafafa", status: "rgba(250,250,250,.4)" },
};

function iconColors(accent: AccentColor): { light: Colors; dark: Colors } {
  if (accent === "neutral") return NEUTRAL_ICON;
  const p = ACCENT_PALETTE[accent];
  return {
    light: { fg: p.logoLight, status: p.ringLight },
    dark: { fg: p.logoDark, status: p.ringDark },
  };
}

/** The favicon: static, on the 16-unit grid, coloured by the browser scheme. */
export function renderBrandIcon(logo: BrandName, accent: AccentColor): string {
  const t = BRAND_LOGO_DEFS[logo].tiles(GRID_16);
  const icon = iconColors(accent);
  const size = GRID_16.tile * 2 + GRID_16.gap;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">`,
    "<style>",
    `.f{fill:${icon.light.fg}}.s{fill:${icon.light.status}}`,
    `@media (prefers-color-scheme: dark){.f{fill:${icon.dark.fg}}.s{fill:${icon.dark.status}}}`,
    "</style>",
    `<path class="f" d="${t.tl}"/>`,
    `<path class="f" d="${t.tr}"/>`,
    `<path class="f" d="${t.bl}"/>`,
    `<path class="s" d="${t.br}"/>`,
    "</svg>",
  ].join("");
}
```

`logoTiles` stays as it is.

- [ ] **Step 4: Update `app/brand/icon.svg/route.ts`**

```ts
import { defaultAccent, isAccent } from "@/lib/accents";
import { renderBrandIcon } from "@/lib/brand-logos";
import { brand } from "@/lib/branding";

// The favicon: BRAND picks the shape, ?accent= the colour (the root layout
// links /brand/icon.svg?accent=<user's accent>). A missing or unknown accent —
// the 404 and error pages link it bare — means the brand default. The output
// depends only on the URL and BRAND, so a public cache is safe. Skips proxy.ts
// (its matcher excludes *.svg), so the sign-in page gets it too.
export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  const param = new URL(request.url).searchParams.get("accent");
  const accent = isAccent(param) ? param : defaultAccent();
  return new Response(renderBrandIcon(brand(), accent), {
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": "public, max-age=3600",
    },
  });
}
```

- [ ] **Step 5: Update `components/brand-mark.tsx`**

Remove the `BRAND_LOGO_DEFS` import and the `fill` lookup, and colour the paths from the tokens. The resulting `BrandLogo` body:

```tsx
import { logoTiles } from "@/lib/brand-logos";
import { APP_NAME, type BrandName } from "@/lib/branding";
import { cn } from "@/lib/utils";

/**
 * The deployment's logo, inline so it takes the accent's colours (--logo and
 * --logo-status, set per accent in globals.css) and animates (motion lives in
 * globals.css under `.brand-logo`). A 24px mark centred in a 32px box: the box
 * matches the sidebar's collapsed icon button, and the mark stays on its
 * whole-pixel grid. Decorative (`aria-hidden`): the app name is always beside
 * it or in a tooltip.
 *
 * `logo` (the shape) comes from `brand()`, read on the server and passed down.
 * `active` makes the status tile pulse — set it while runs are in progress.
 */
export function BrandLogo({
  logo,
  active = false,
  className,
}: {
  logo: BrandName;
  active?: boolean;
  className?: string;
}) {
  const tiles = logoTiles(logo);
  return (
    <span
      className={cn(
        "brand-logo grid size-8 shrink-0 place-items-center",
        className
      )}
      data-active={active || undefined}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        // `!`: SidebarMenuButton forces every descendant svg to size-4.
        className="size-6! overflow-visible"
      >
        <path className="brand-tile brand-tile-tl fill-(--logo)" d={tiles.tl} />
        <path className="brand-tile brand-tile-bl fill-(--logo)" d={tiles.bl} />
        <path className="brand-tile brand-tile-tr fill-(--logo)" d={tiles.tr} />
        <path
          className="brand-tile brand-tile-br fill-(--logo-status)"
          d={tiles.br}
        />
      </svg>
    </span>
  );
}
```

`BrandMark` is unchanged.

- [ ] **Step 6: Update the `BRANDS` doc comment in `lib/branding.ts`**

Replace the comment above `export const BRANDS` with:

```ts
/**
 * Brands a deployment can choose from. A brand is a logo shape
 * (lib/brand-logos.ts) and a default accent colour (lib/accents.ts).
 */
```

- [ ] **Step 7: Run the tests and typecheck**

Run: `bun test tests/brand-icon.test.ts && bunx tsc --noEmit --incremental false`
Expected: tests PASS (6) and no TS errors. Nothing else calls `GET` or `renderBrandIcon`, so the signature changes touch only these files.

- [ ] **Step 8: Commit**

```bash
git add lib/brand-logos.ts lib/branding.ts components/brand-mark.tsx app/brand/icon.svg/route.ts tests/brand-icon.test.ts
git commit -m "feat(brand): logo and favicon take the accent colour"
```

---

### Task 4: Store the accent per user and render it

**Files:**
- Create: `drizzle/20261012000000_accent_color/migration.sql`
- Modify: `lib/db/schema.ts` (users table, after `avatarSource`, around line 668)
- Modify: `lib/auth.ts` (`user.additionalFields`, around line 111)
- Modify: `actions/profile.ts` (add `setAccentColor`)
- Modify: `app/[locale]/layout.tsx` (`data-accent` on `<html>`, favicon URL in `generateMetadata`)

**Interfaces:**
- Consumes: `accentSchema`, `effectiveAccent`, `brandIconSrc`, `type AccentColor` (Task 1).
- Produces:
  - `setAccentColor(input: unknown): Promise<ActionResponse>`;
  - `session.user.accentColor: string | null | undefined`;
  - `<html data-accent>`;
  - `const accent: AccentColor` in the layout body, passed to `AccentProvider` in Task 5.

- [ ] **Step 1: Check the parallel `display_name` work**

Run: `git log --oneline -15 && ls drizzle | tail -4 && grep -n "displayName\|display_name" lib/db/schema.ts lib/auth.ts`
Expected: either nothing (not landed yet) or a `display_name` migration and column. Both are fine. If it has landed, add `accentColor` next to it without touching it, and keep this migration's own timestamp.

- [ ] **Step 2: Write the migration** `drizzle/20261012000000_accent_color/migration.sql`

```sql
-- Per-user accent colour (docs/superpowers/specs/2026-10-12-accent-colors-design.md).
-- Additive and nullable: NULL means "brand default", and the running build
-- ignores the column, so this can be applied before the deploy. No CHECK
-- constraint: the app validates against lib/accents.ts ACCENTS and falls back
-- on unknown values, so adding a colour later needs no migration.
BEGIN;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "accent_color" text;

COMMIT;
```

- [ ] **Step 3: Add the column to `lib/db/schema.ts`**

Directly after the `avatarSource: text("avatar_source").$type<AvatarSource>(),` line in the `users` table:

```ts
    // lib/accents.ts ACCENTS; null = the brand default (effectiveAccent).
    accentColor: text("accent_color").$type<AccentColor>(),
```

Then add `import type { AccentColor } from "@/lib/accents";` alongside the file's other imports, matching the existing import style at the top of the file.

- [ ] **Step 4: Register it with better-auth in `lib/auth.ts`**

In `user.additionalFields`, after `avatarSource: { … },`:

```ts
      accentColor: { type: "string", required: false, input: false },
```

- [ ] **Step 5: Add the server action to `actions/profile.ts`**

Add to the imports: `import { accentSchema } from "@/lib/accents";`. Then append:

```ts
/** Save the caller's accent colour. The UI applies it optimistically. */
export async function setAccentColor(input: unknown): Promise<ActionResponse> {
  const session = await requireSession();
  const t = await getTranslations("actionErrors");
  const parsed = accentSchema.safeParse(input);
  if (!parsed.success) return { success: false, message: t("invalidInput") };

  await db
    .update(users)
    .set({ accentColor: parsed.data, updatedAt: new Date() })
    .where(eq(users.id, session.user.id));

  // The accent is on <html> and in the favicon link on every page.
  revalidatePath("/", "layout");
  return { success: true };
}
```

- [ ] **Step 6: Render the accent in `app/[locale]/layout.tsx`**

1. Imports: change `import { BRAND_ICON_SRC, brand } from "@/lib/branding";` to `import { brand } from "@/lib/branding";` and add `import { brandIconSrc, effectiveAccent } from "@/lib/accents";`.

2. In `generateMetadata`, compute the user's accent for the favicon:

```ts
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "app" });
  // getServerSession is request-cached, so this costs no extra lookup.
  const session = await getServerSession();
  return {
    title: t("name"),
    description: t("name"),
    icons: {
      icon: {
        url: brandIconSrc(effectiveAccent(session?.user)),
        type: "image/svg+xml",
      },
    },
  };
```

3. In the component body, replace the `currentBrand` block with:

```ts
  // Logo shape (BRAND) and accent colour (the user's choice, else the brand
  // default) — both select CSS in globals.css via data-* on <html>.
  const currentBrand = brand();
  const accent = effectiveAccent(session?.user);
```

and add `data-accent={accent}` to `<html>` next to `data-brand={currentBrand}`.

- [ ] **Step 7: Typecheck, run the tests and build**

Run: `bunx tsc --noEmit --incremental false && bun test && bun run build; echo "build exit=$?"`
Expected: no TS errors (`session.user.accentColor` is typed through `additionalFields`), all tests pass, `build exit=0`.

- [ ] **Step 8: Commit**

```bash
git add drizzle/20261012000000_accent_color lib/db/schema.ts lib/auth.ts actions/profile.ts "app/[locale]/layout.tsx"
git commit -m "feat(accents): store the accent per user and render it on <html> and the favicon"
```

---

### Task 5: Accent picker in the user menu and command palette

**Files:**
- Create: `components/accent-provider.tsx` (context, optimistic apply and rollback)
- Create: `components/accent-dot.tsx` (colour swatch with literal Tailwind classes)
- Create: `lib/accent-state.ts` (pure helper for the optimistic/rollback decision)
- Modify: `components/user-menu.tsx` (submenu after Theme)
- Modify: `components/command-palette.tsx` (group after Theme)
- Modify: `app/[locale]/layout.tsx` (wrap the signed-in shell in `AccentProvider`)
- Modify: `messages/{ar,en,es,id,zh}.json` (new `accentSwitcher` namespace)
- Test: `tests/accent-state.test.ts`

**Interfaces:**
- Consumes: `ACCENTS`, `brandIconSrc`, `type AccentColor` (Task 1); `setAccentColor` (Task 4); `accent` from the layout (Task 4).
- Produces:
  - `AccentProvider({ initial: AccentColor, children })`;
  - `useAccent(): { accent: AccentColor; setAccent(next: AccentColor): void }`;
  - `AccentDot({ accent: AccentColor; className?: string })`;
  - `nextAccentState(current, requested, outcome)`.

- [ ] **Step 1: Write the failing test** `tests/accent-state.test.ts`

```ts
import { describe, expect, it } from "bun:test";
import { nextAccentState } from "@/lib/accent-state";

describe("nextAccentState", () => {
  it("applies the requested accent optimistically", () => {
    expect(nextAccentState("blue", "rose", "pending")).toEqual({
      apply: "rose",
      rollbackTo: "blue",
    });
  });

  it("keeps the new accent when the save succeeds", () => {
    expect(nextAccentState("blue", "rose", "saved")).toEqual({
      apply: "rose",
      rollbackTo: null,
    });
  });

  it("rolls back to the previous accent when the save fails", () => {
    expect(nextAccentState("blue", "rose", "failed")).toEqual({
      apply: "blue",
      rollbackTo: null,
    });
  });

  it("does nothing when the accent is unchanged", () => {
    expect(nextAccentState("blue", "blue", "pending")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/accent-state.test.ts`
Expected: FAIL with `Cannot find module '@/lib/accent-state'`.

- [ ] **Step 3: Implement `lib/accent-state.ts`**

```ts
import type { AccentColor } from "@/lib/accents";

/**
 * What the picker should show at each stage of a change: the requested
 * accent at once (optimistic), kept when the save succeeds, and the previous
 * one restored when it fails. `null` means nothing to do.
 */
export function nextAccentState(
  current: AccentColor,
  requested: AccentColor,
  outcome: "pending" | "saved" | "failed"
): { apply: AccentColor; rollbackTo: AccentColor | null } | null {
  if (requested === current && outcome === "pending") return null;
  if (outcome === "pending") return { apply: requested, rollbackTo: current };
  if (outcome === "saved") return { apply: requested, rollbackTo: null };
  return { apply: current, rollbackTo: null };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/accent-state.test.ts`
Expected: PASS (4).

- [ ] **Step 5: Create `components/accent-dot.tsx`**

```tsx
import type { AccentColor } from "@/lib/accents";
import { cn } from "@/lib/utils";

// Literal classes so Tailwind's scanner emits them: each accent's primary step
// (900 light / 300 dark), matching the button colour it will produce.
const DOT: Record<AccentColor, string> = {
  neutral: "bg-neutral-900 dark:bg-neutral-100",
  blue: "bg-blue-900 dark:bg-blue-300",
  green: "bg-green-900 dark:bg-green-300",
  orange: "bg-orange-900 dark:bg-orange-300",
  red: "bg-red-900 dark:bg-red-300",
  rose: "bg-rose-900 dark:bg-rose-300",
  violet: "bg-violet-900 dark:bg-violet-300",
  yellow: "bg-yellow-900 dark:bg-yellow-300",
};

/** A small swatch for an accent; decorative, the name is always beside it. */
export function AccentDot({
  accent,
  className,
}: {
  accent: AccentColor;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-3 shrink-0 rounded-full ring-1 ring-border",
        DOT[accent],
        className
      )}
    />
  );
}
```

- [ ] **Step 6: Create `components/accent-provider.tsx`**

```tsx
"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { setAccentColor } from "@/actions/profile";
import { type AccentColor, brandIconSrc } from "@/lib/accents";
import { nextAccentState } from "@/lib/accent-state";

type AccentContextValue = {
  accent: AccentColor;
  setAccent: (next: AccentColor) => void;
};

const AccentContext = React.createContext<AccentContextValue | null>(null);

/** Repaint the page and favicon for `accent` without waiting for the server. */
function paint(accent: AccentColor) {
  document.documentElement.dataset.accent = accent;
  for (const link of document.querySelectorAll<HTMLLinkElement>(
    'link[rel="icon"]'
  )) {
    link.href = brandIconSrc(accent);
  }
}

/**
 * The signed-in user's accent. `initial` is what the server rendered on
 * <html data-accent>; changes repaint at once and save in the background,
 * rolling back with a toast if the save fails.
 */
export function AccentProvider({
  initial,
  children,
}: {
  initial: AccentColor;
  children: React.ReactNode;
}) {
  const t = useTranslations("accentSwitcher");
  const [accent, setAccentState] = React.useState(initial);
  const [, startTransition] = React.useTransition();

  const setAccent = React.useCallback(
    (requested: AccentColor) => {
      const optimistic = nextAccentState(accent, requested, "pending");
      if (!optimistic) return;
      paint(optimistic.apply);
      setAccentState(optimistic.apply);
      startTransition(async () => {
        let outcome: "saved" | "failed" = "failed";
        try {
          outcome = (await setAccentColor(requested)).success ? "saved" : "failed";
        } catch {
          outcome = "failed";
        }
        const settled = nextAccentState(accent, requested, outcome);
        if (settled && outcome === "failed") {
          paint(settled.apply);
          setAccentState(settled.apply);
          toast.error(t("saveFailed"));
        }
      });
    },
    [accent, t]
  );

  const value = React.useMemo(() => ({ accent, setAccent }), [accent, setAccent]);
  return <AccentContext.Provider value={value}>{children}</AccentContext.Provider>;
}

export function useAccent(): AccentContextValue {
  const ctx = React.useContext(AccentContext);
  if (!ctx) throw new Error("useAccent must be used inside AccentProvider");
  return ctx;
}
```

- [ ] **Step 7: Wrap the signed-in shell in `app/[locale]/layout.tsx`**

Add `import { AccentProvider } from "@/components/accent-provider";`. Inside the `session ? (` branch, wrap the existing `<ActiveRunsProvider>…</ActiveRunsProvider>` element:

```tsx
                  <AccentProvider initial={accent}>
                    <ActiveRunsProvider>
                      {/* …unchanged children… */}
                    </ActiveRunsProvider>
                  </AccentProvider>
```

Both `AppSidebar` (and its `UserMenu`) and `CommandPalette` are inside `ActiveRunsProvider`, so they get the context.

- [ ] **Step 8: Add the submenu to `components/user-menu.tsx`**

Imports: add `import { useAccent } from "@/components/accent-provider";`, `import { AccentDot } from "@/components/accent-dot";` and `import { ACCENTS, type AccentColor } from "@/lib/accents";`. In `UserMenu`, next to `const tTheme = …`:

```ts
  const tAccent = useTranslations("accentSwitcher");
  const { accent, setAccent } = useAccent();
```

Directly after the closing `</DropdownMenuSub>` of the Theme submenu (and before the Language `<DropdownMenuSub>`):

```tsx
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <AccentDot accent={accent} className="mx-0.5" />
              {tAccent("ariaLabel")}
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={accent}
                  onValueChange={(v) => setAccent(v as AccentColor)}
                >
                  {ACCENTS.map((a) => (
                    <DropdownMenuRadioItem key={a} value={a}>
                      <AccentDot accent={a} />
                      {tAccent(a)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
```

- [ ] **Step 9: Add the group to `components/command-palette.tsx`**

Imports: the same three as in Step 8. Inside the component, next to the existing `useTheme()` call:

```ts
  const tAccent = useTranslations("accentSwitcher");
  const { setAccent } = useAccent();
```

After the Theme `</CommandGroup>`, before the Language `<CommandSeparator />`:

```tsx
          <CommandSeparator />
          <CommandGroup heading={tAccent("ariaLabel")}>
            {ACCENTS.map((a) => (
              <CommandItem
                key={a}
                value={`accent ${a}`}
                onSelect={() => run(() => setAccent(a))}
              >
                <AccentDot accent={a} />
                {tAccent(a)}
              </CommandItem>
            ))}
          </CommandGroup>
```

- [ ] **Step 10: Add the `accentSwitcher` namespace to all five locales**

Add a top-level key `"accentSwitcher"` right after `"themeSwitcher"` in each file:

`messages/en.json`:
```json
  "accentSwitcher": {
    "ariaLabel": "Accent color",
    "neutral": "Neutral",
    "blue": "Blue",
    "green": "Green",
    "orange": "Orange",
    "red": "Red",
    "rose": "Rose",
    "violet": "Violet",
    "yellow": "Yellow",
    "saveFailed": "Couldn't save the accent color."
  },
```

`messages/id.json`:
```json
  "accentSwitcher": {
    "ariaLabel": "Warna aksen",
    "neutral": "Netral",
    "blue": "Biru",
    "green": "Hijau",
    "orange": "Oranye",
    "red": "Merah",
    "rose": "Mawar",
    "violet": "Ungu",
    "yellow": "Kuning",
    "saveFailed": "Gagal menyimpan warna aksen."
  },
```

`messages/es.json`:
```json
  "accentSwitcher": {
    "ariaLabel": "Color de acento",
    "neutral": "Neutro",
    "blue": "Azul",
    "green": "Verde",
    "orange": "Naranja",
    "red": "Rojo",
    "rose": "Rosa",
    "violet": "Violeta",
    "yellow": "Amarillo",
    "saveFailed": "No se pudo guardar el color de acento."
  },
```

`messages/zh.json`:
```json
  "accentSwitcher": {
    "ariaLabel": "强调色",
    "neutral": "中性",
    "blue": "蓝色",
    "green": "绿色",
    "orange": "橙色",
    "red": "红色",
    "rose": "玫瑰色",
    "violet": "紫罗兰色",
    "yellow": "黄色",
    "saveFailed": "无法保存强调色。"
  },
```

`messages/ar.json`:
```json
  "accentSwitcher": {
    "ariaLabel": "لون التمييز",
    "neutral": "محايد",
    "blue": "أزرق",
    "green": "أخضر",
    "orange": "برتقالي",
    "red": "أحمر",
    "rose": "وردي",
    "violet": "بنفسجي",
    "yellow": "أصفر",
    "saveFailed": "تعذّر حفظ لون التمييز."
  },
```

Check that the five files keep identical key sets:
Run: `python3 -c "import json;k=[set(json.load(open(f'messages/{l}.json'))['accentSwitcher']) for l in ['ar','en','es','id','zh']];print(all(x==k[0] for x in k), sorted(k[0]))"`
Expected: `True` and the 10 keys.

- [ ] **Step 11: Run the full gate**

Run: `bun run biome check --write . && bun run biome ci . && bunx tsc --noEmit --incremental false && bun test && bun run build; echo "build exit=$?"`
Expected: Biome clean, no TS errors, all tests pass, `build exit=0`.

- [ ] **Step 12: Commit**

```bash
git add lib/accent-state.ts tests/accent-state.test.ts components/accent-provider.tsx components/accent-dot.tsx components/user-menu.tsx components/command-palette.tsx "app/[locale]/layout.tsx" messages
git commit -m "feat(accents): accent picker in the user menu and command palette"
```

---

### Task 6: Visual verification and rollout

**Files:**
- No source changes, unless verification finds a defect. In that case, fix it in the owning file with a test, and commit as `fix(accents): …`.

**Interfaces:**
- Consumes: everything above.
- Produces: a contact sheet for the user, a clean Docker build, the migration applied to prod (with the user's go-ahead), and verification after the user deploys.

- [ ] **Step 1: Start the temporary environment** (temporary Postgres with all migrations, a test user, sample issues, headless Chrome)

```bash
export CONTAINERS_REGISTRIES_CONF=/tmp/registries.conf   # podman short-name resolution
printf 'unqualified-search-registries = ["docker.io"]\nshort-name-mode = "permissive"\n' > /tmp/registries.conf
podman rm -f opsdeck-accent-db accent-chrome >/dev/null 2>&1
podman run -d --name opsdeck-accent-db -e POSTGRES_PASSWORD=test -e POSTGRES_DB=opsdeck -p 127.0.0.1:55432:5432 postgres:18
until podman exec opsdeck-accent-db pg_isready -U postgres -q; do sleep 1; done
for d in $(ls drizzle | sort); do f=drizzle/$d/migration.sql; [ -f "$f" ] && podman exec -i opsdeck-accent-db psql -q -U postgres -d opsdeck -v ON_ERROR_STOP=1 < "$f"; done
podman run -d --name accent-chrome --network host docker.io/chromedp/headless-shell:latest --remote-debugging-address=127.0.0.1 --remote-debugging-port=9223 --no-sandbox --disable-gpu --hide-scrollbars
```

Create the test user, a project and 8 issues assigned to it. Hash the password with `bun -e 'import { hashPassword } from "better-auth/crypto"; console.log(await hashPassword("accent-test-password-123"))'`, then insert into `users`, `accounts` (`provider_id='credential'`), `projects`, and `issues` (`status` `in_progress` or `open`, `assignee_id` = the user).

Start the standalone build (`.next/standalone/server.js`, after copying `.next/static`) on port 3199 with `BRAND=dss`, a valid `SECRETS_KEY`, `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL=http://localhost:3199`, S3, imgproxy and Redis unset. Then sign in with `POST /api/auth/sign-in/email` and keep the cookie jar.

- [ ] **Step 2: Capture the contact sheet**

Write `/tmp/cdp-accents.ts`, a CDP script against `http://127.0.0.1:9223`. It sets the session cookie, sets the viewport to 1306×632 at DPR 1.2, and then, for each accent in `ACCENTS` and each theme in `light`/`dark`:
1. run `UPDATE users SET accent_color = '<accent>'` through `podman exec … psql`;
2. load `/en` with `localStorage.theme` set;
3. take a screenshot.

Compose the 16 screenshots into `/tmp/accent-sheet.png` with `sharp` (8 rows × 2 columns), and show it to the user.

Expected: each accent colours the "New issue" button, the active sidebar item, the logo and the focus ring as specified, and the neutral greys are identical across rows.

- [ ] **Step 3: Check the picker interaction**

With the same script:
1. open the user menu, hover "Accent color", and screenshot the open submenu;
2. click "Rose" and assert `document.documentElement.dataset.accent === "rose"` and that `link[rel=icon]` `href` ends with `?accent=rose`;
3. reload and assert it is still `rose`, which proves the save landed;
4. stop the DB container, click "Violet", and assert that it reverts to `rose` and a toast appears. Restart the DB afterwards.

- [ ] **Step 4: Gate and clean-clone image build**

```bash
bun run biome ci . && bunx tsc --noEmit --incremental false && bun test && bun run build; echo "build exit=$?"
rm -rf /tmp/opsdeck-img && git clone -q . /tmp/opsdeck-img && (cd /tmp/opsdeck-img && podman build -t opsdeck-app:accent-test . 2>&1 | tail -2)
podman rmi -f localhost/opsdeck-app:accent-test
```

Expected: all green, `build exit=0`, `Successfully tagged`.

- [ ] **Step 5: Tear down**

```bash
pkill -f "^bun server.js"; podman rm -f opsdeck-accent-db accent-chrome
```

- [ ] **Step 6: Live migration. Ask the user for the go-ahead first.**

On `ssh root@192.168.56.113` (office VPN):
1. Back up: `pg_dump -Fc -d dss_panel` to `/root/backups/dss_panel_pre_accent_color_<ts>.dump`, verify with `pg_restore -l`, `scp` it to `~/backups/opsdeck/`, and compare md5.
2. Dry run: pipe `{ sed 's/^COMMIT;$//' drizzle/20261012000000_accent_color/migration.sql; printf "SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='accent_color';\nROLLBACK;\n"; } | ssh root@192.168.56.113 'docker exec -i opsdeck-postgres psql -U postgres -d dss_panel -v ON_ERROR_STOP=1'`. Expect one row, then `ROLLBACK`.
3. Apply: `ssh root@192.168.56.113 'docker exec -i opsdeck-postgres psql -U postgres -d dss_panel -v ON_ERROR_STOP=1' < drizzle/20261012000000_accent_color/migration.sql`.
4. Record it in the `rework-migrations-applied` memory.

- [ ] **Step 7: Push and hand over the deploy**

Run: `git push origin main`. Then tell the user to run the Jenkins job `dss-panel`. No `.env` change.

- [ ] **Step 8: Verify prod after the user deploys**

```bash
ssh root@192.168.56.113 'H="Host: panel.dssconsulting.id"; cd /var/lib/jenkins/workspace/dss-panel && git log --oneline -1; docker ps --filter name=opsdeck-app --format "{{.Status}}"; curl -s -H "$H" http://localhost:80/en/sign-in | grep -oE "<html[^>]*>|<link rel=\"icon\"[^>]*>"; curl -s -o /dev/null -w "%{http_code} %{content_type}\n" -H "$H" "http://localhost:80/brand/icon.svg?accent=rose"; docker logs --since 10m opsdeck-app 2>&1 | grep -iE "error|schema" | grep -v "Failed to find Server Action" | head'
```

Expected:
- the new commit, and the container healthy;
- `<html … data-accent="blue">` with the favicon link `?accent=blue` on the sign-in page (no user, so the brand default);
- `200 image/svg+xml`;
- no errors.
