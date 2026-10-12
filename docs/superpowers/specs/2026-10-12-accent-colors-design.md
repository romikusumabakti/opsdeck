# Accent colours: Tailwind palette, chosen per user — design

## Goal

1. Use colours from the Tailwind palette instead of the hand-picked DSS hexes. The DSS default becomes the Tailwind blue closest to DSS navy.
2. Let each user pick an accent colour from shadcn/ui's colour themes. The choice follows them to every device.

## Problems with the current state

- The `dss` brand theme (`app/globals.css`, `[data-brand="dss"]` blocks) uses custom navy tokens (`#203864`, `#3f72d6`, ...) that are not Tailwind colours. Its neutrals carry a navy cast, which only suits blue.
- There is no per-user colour choice. Only light/dark/system exists: per device, through next-themes, in the user menu.
- Some of shadcn's own colour themes fail WCAG AA if copied verbatim. White on `green-600` is 3.29:1 and white on `orange-500` is 2.80:1. So the steps cannot be taken from shadcn as-is.

## Decisions (from brainstorming, 2026-10-12)

| Topic | Decision |
|---|---|
| Neutrals | Stock shadcn neutral greys for every accent. The navy-tinted `dss` neutral blocks are removed. |
| Choices | shadcn's seven colour themes, `blue green orange red rose violet yellow`, plus `neutral` (stock black/white). |
| Depth | Step **900** in light mode and step **300** in dark mode for every colour. `blue-900` is the Tailwind blue step closest to DSS navy (ΔE 0.072 in OKLab; `blue-950` is nearer at 0.065, but at step 950 most other colours go near-black and lose their hue, and the same step is used for every colour). Picked from a side-by-side mockup against shadcn's 600/400. |
| Storage | Per account: a column on `users`, synced across devices. |
| Logo | Follows the user's accent. `neutral` gives a black/white logo. |
| Picker | A submenu in the user menu, next to Theme, plus command-palette entries. |
| Mechanism | A `data-accent` attribute on `<html>` and static CSS blocks that bind Tailwind palette variables. Rejected alternatives: CSS generated at runtime from TS (uncacheable, overkill for 8 static sets) and a single `--accent-hue` formula (does not produce Tailwind palette colours). |

## Data model

- New column `users.accent_color text NULL` (Drizzle `accentColor`, typed `AccentColor`).
  - `NULL` means the user has never chosen and follows the brand default.
  - No CHECK constraint and no backfill. Validation lives in the app, so adding a colour later needs no migration.
- It is registered in better-auth `user.additionalFields` as `{ type: "string", required: false, input: false }`, like `timezone`. That way it is present on `session.user`, passes better-auth 1.7's startup schema check, and cannot be written through the auth API.
- `lib/accents.ts`:
  - `ACCENTS = ["neutral", "blue", "green", "orange", "red", "rose", "violet", "yellow"] as const` and `type AccentColor`;
  - `BRAND_DEFAULT_ACCENT: Record<BrandName, AccentColor> = { default: "neutral", dss: "blue" }`;
  - `effectiveAccent(user)` returns the stored value when it is one of `ACCENTS`, otherwise `BRAND_DEFAULT_ACCENT[brand()]`. The shape mirrors `effectiveTimeZone`. Unknown stored values (for example a colour removed later) fall back silently.

## Mutation

`setAccentColor(accent)` in `actions/profile.ts`:
- `requireSession()`;
- zod `z.enum(ACCENTS)`, with any other input rejected as `invalidInput`;
- updates only the caller's row and sets `updatedAt`;
- `revalidatePath("/", "layout")`.

There is no "reset to default" option: choosing the brand's default colour stores it explicitly.

## Theme tokens (`app/globals.css`)

Two layers, so that no large block is repeated per colour.

**1. Palette binding, one small block per colour except `neutral`.** It only names the Tailwind steps used:

```css
[data-accent="green"] {
  --tint-100: var(--color-green-100);
  --tint-200: var(--color-green-200);
  --tint-300: var(--color-green-300);
  --tint-400: var(--color-green-400);
  --tint-900: var(--color-green-900);
  --tint-950: var(--color-green-950);
  --tint-ring-light: var(--color-green-600);
  --tint-ring-dark: var(--color-green-400);
}
```

The prefix is `--tint-*` because shadcn already uses `--accent` for hover backgrounds.

**2. Roles, two blocks** that apply to every accent except `neutral`. The selectors are `[data-accent]:not([data-accent="neutral"]):not(.dark)` and `.dark[data-accent]:not([data-accent="neutral"])`. They outrank `:root` and `.dark`.

| Token | Light | Dark |
|---|---|---|
| `--primary`, `--sidebar-primary` | `--tint-900` | `--tint-300` |
| `--primary-foreground`, `--sidebar-primary-foreground` | `oklch(1 0 0)` | `oklch(0.145 0 0)` |
| `--ring`, `--sidebar-ring` | `--tint-ring-light` | `--tint-ring-dark` |
| `--sidebar-accent` | `--tint-100` | `--tint-950` |
| `--sidebar-accent-foreground` | `--tint-900` | `--tint-200` |
| `--logo` (new) | `--tint-900` | `--tint-200` |
| `--logo-status` (new) | `--tint-ring-light` | `--tint-ring-dark` |

**Ring steps.** The ring step is 500 (light) and 400 (dark) unless that fails 3:1 against the page background (WCAG 1.4.11). In that case the next darker (light) or lighter (dark) step that passes is used. Computed from the Tailwind 4.3.3 palette, with ratios against the stock background:

| Colour | Ring light | Ring dark |
|---|---|---|
| blue | 500 (3.76) | 400 (7.51) |
| green | **600** (3.22) | 400 (11.15) |
| orange | **600** (3.59) | 400 (8.32) |
| red | 500 (3.82) | 400 (6.84) |
| rose | 500 (3.76) | 400 (6.92) |
| violet | 500 (4.40) | 400 (6.94) |
| yellow | **700** (4.92) | 400 (12.62) |

Measured contrast for the text pairs:
- White on step 900: at least 8.7:1.
- Ink on step 300: at least 8.8:1.
- Active sidebar item: light 100/900 and dark 950/200, all between 8.0 and 12.5:1.

**`neutral`** gets no binding block and no role override, so its tokens are exactly the stock shadcn set. `:root` defines the logo defaults, `--logo: var(--foreground)` and `--logo-status: color-mix(in oklab, var(--foreground) 40%, transparent)`, which give `neutral` its black/white logo. The role blocks override both for the coloured accents.

**Removed:** the `[data-brand="dss"]:not(.dark)` and `.dark[data-brand="dss"]` token blocks, and `tests/brand-theme.test.ts`, which is replaced by the accent test below. `data-brand` stays on `<html>` but no longer drives colour. `BRAND` now selects only the logo shape and the default accent.

**Unchanged:** background, card, popover, border, input, muted, secondary and accent greys (stock); destructive, success and the amber/emerald status colours; charts; radius; fonts.

The sidebar's hover and active states share `--sidebar-accent` (shadcn's `sidebar.tsx`), so hover is tinted too. This is accepted, rather than forking the component.

## Logo and favicon

- `components/brand-mark.tsx` → `BrandLogo` fills its tiles with `fill-(--logo)` and the status tile with `fill-(--logo-status)`. It has no colour props. A change of `data-accent` recolours it immediately, and the animation is unchanged.
- `lib/brand-logos.ts` keeps only the geometry per brand (plain grid for `default`, the "D" grid for `dss`). The per-brand `fill` and `icon` colours are removed.
- Favicon:
  - The layout metadata sets `icons.icon.url` to `/brand/icon.svg?accent=<effectiveAccent>`.
  - `app/brand/icon.svg/route.ts` reads the `accent` search param. An invalid or missing value means the brand default.
  - It draws the `BRAND` shape on the 16-unit grid, coloured for `prefers-color-scheme`: light uses the logo step 900 and the status ring-light step; dark uses 200 and ring-dark. `neutral` keeps the current black/white plus 40% colours.
  - The output depends only on the URL, so `Cache-Control: public` is kept.
- `lib/accent-palette.ts` holds the oklch strings the favicon needs: each colour's 200, 900, ring-light and ring-dark steps. The favicon cannot read page CSS variables, so the values must live in TS. A test asserts that every value equals `node_modules/tailwindcss/theme.css`, so a Tailwind upgrade that shifts the palette fails CI instead of drifting.
- Pages without a user (sign-in, setup, password reset, invitation, the root 404 and global-error pages) use the brand default accent. `app/not-found.tsx` and `app/global-error.tsx` keep their explicit `<link rel="icon">` to `/brand/icon.svg` with no `accent` param, and the route falls back to the brand default. `global-error` is a client component and cannot read the server-only `BRAND`, so it must not compute the param itself.

## Picker UI

**User menu (`components/user-menu.tsx`).** A new `DropdownMenuSub` "Accent color" goes between Theme and Language, with the same structure as the Theme submenu.
- The trigger icon is a dot in the current accent's primary colour (`bg-primary`, or `bg-foreground` for `neutral`).
- The content is a `DropdownMenuRadioGroup` with 8 items, each a colour dot plus its name. A dot shows the colour's primary step for the current mode (light 900, dark 300) and has a `ring-1 ring-border` outline so light colours stay visible. The Tailwind classes are written out literally, so the scanner sees them.
- On select:
  1. set `document.documentElement.dataset.accent` and the favicon `<link rel="icon">` `href` immediately;
  2. call `setAccentColor` in a transition;
  3. on failure, restore both and show a toast.

**Command palette (`components/command-palette.tsx`).** A new group "Accent color" with 8 items, mirroring the existing theme group.

**i18n.** A new `accentSwitcher` namespace (`ariaLabel`, the 8 colour names, `saveFailed`) in all of `messages/{ar,en,es,id,zh}.json`.

**Accessibility.** Every option is named in text, never colour-only. Radio semantics and keyboard navigation come from the menu component.

## Testing

Write the tests first.

- `tests/accent-theme.test.ts`: reads `app/globals.css` and resolves `var(--color-*)` from `node_modules/tailwindcss/theme.css`. For each accent and mode:
  - `primary-foreground` on `primary` is at least 4.5:1;
  - `sidebar-accent-foreground` on `sidebar-accent` is at least 4.5:1;
  - `ring` against `background` is at least 3:1;
  - every coloured accent has a binding block, and `neutral` has none.
- `tests/accent-palette.test.ts`: every value in `lib/accent-palette.ts` equals the Tailwind palette.
- `tests/accents.test.ts`: `effectiveAccent` returns a valid stored value; null or unknown falls back to the brand default for both brands.
- `setAccentColor` input validation: the zod schema rejects anything outside `ACCENTS`.
- `tests/brand-icon.test.ts`, updated: a valid `?accent=` colours the icon; an invalid or missing value uses the brand default; `neutral` is black/white; both schemes are present.
- Visual check against the real app (headless Chrome, temporary Postgres with sample data):
  - Home for 8 accents × light/dark on one contact sheet for review;
  - the user menu with the submenu open;
  - choosing a colour recolours the UI, logo and favicon immediately, and the choice survives a reload.
- Gate: `bun run biome ci .`, `bunx tsc --noEmit --incremental false`, `bun test`, and `bun run build` (check the exit code), plus a Docker image build from a clean clone.

## Migration and deploy

1. `drizzle/20261012000000_accent_color/migration.sql`: `BEGIN; ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "accent_color" text; COMMIT;`
   - Additive and nullable, so the running build ignores it.
   - Before writing it, check whether the parallel `display_name` migration has landed. If its timestamp sorts after this one, keep both: they touch different columns. Only the apply order on the live DB must follow the deploy order. Conflicts are limited to `lib/db/schema.ts` and `lib/auth.ts` in git.
2. On the live DB: back up (`pg_dump -Fc`, verify, copy locally, compare md5), dry-run (COMMIT swapped for ROLLBACK), then apply. This happens **before** deploy.
3. Push `main`. This does not deploy.
4. The user runs the Jenkins job `dss-panel`. No `.env` change: `BRAND=dss` stays and the default accent is blue.
5. Verify from the host with `-H 'Host: panel.dssconsulting.id'`: `data-accent` on `<html>`, the favicon URL, and no errors in the app log.

## Out of scope

- Moving light/dark/system from per-device to per-account.
- An Account "Appearance" page.
- Organisation-wide accent settings beyond the `BRAND` default.
- Accent-specific charts or status colours.
- Splitting the sidebar's hover and active tokens.
