# Nusantara motif watermarks — design

Date: 2026-10-14 · Status: approved in brainstorming, awaiting spec review

## Goal

Faint traditional Indonesian ornaments in the empty corners of the
unauthenticated pages (sign-in and friends) and of the sidebar — like the
Microsoft 365 background art, a letterhead flourish or a document watermark.
The motif is coloured by the current theme (light/dark) and accent, changes
daily, can be pinned or turned off per account, and carries a short cultural
note so the decoration doubles as a small piece of cultural insight.

Images come from `gpt-image-2.5-sunburst` (quality `medium`), not hand-drawn
SVG: a home-made drawing would not resemble the real motifs.

## Motifs

Eleven, one per major region, ordered west → east by the longitude of the
motif's home (verified by a test). Titles use the standard Indonesian name;
the local name appears in the caption.

| # | Slug | Title | Local name | Origin | Medium | Longitude |
|---|---|---|---|---|---|---|
| 1 | `pintu-aceh` | Pintu Aceh | Pinto Aceh | Aceh | gold filigree jewellery, carving | 95.32 |
| 2 | `gorga` | Gorga | Gorga Simeol-eol | Batak Toba, North Sumatra | carved & painted wood | 99.06 |
| 3 | `pucuk-rebung` | Pucuk Rebung | Pucuak Rabuang | Malay & Minangkabau, West Sumatra | songket, carving | 100.37 |
| 4 | `megamendung` | Megamendung | — | Cirebon, West Java | batik tulis (pesisiran) | 108.55 |
| 5 | `kawung` | Kawung | — | Java, Yogyakarta | batik (keraton) | 110.36 |
| 6 | `batang-garing` | Batang Garing | — | Dayak Ngaju, Central Kalimantan | carving, batik benang bintik | 113.92 |
| 7 | `patra-punggel` | Patra Punggel | — | Bali | stone & wood carving | 115.22 |
| 8 | `pa-barre-allo` | Pa' Barre Allo | Passura' | Toraja, South Sulawesi | carved & painted wood | 119.89 |
| 9 | `mamuli` | Mamuli | — | Sumba, East Nusa Tenggara | tenun ikat (hinggi) | 120.26 |
| 10 | `tenun-tanimbar` | Tenun Tanimbar | Tais | Tanimbar, Maluku | tenun ikat (orchid motif) | 131.30 |
| 11 | `ukiran-asmat` | Ukiran Asmat | — | Asmat, South Papua | wood carving | 138.13 |

Notes from research:
- Megamendung is Cirebonan (north-coast batik), not Priangan Sundanese.
- "Gorga" is a family of ~17 motifs; the image follows Simeol-eol plus the
  ipon-ipon sawtooth border.
- Tanimbar: orchid (anggrek) is cited as the main motif; Tanimbar ikat holds a
  Geographical Indication (2017).
- Asmat chosen over Sentani Fouw for recognisability (and thus image
  fidelity); the art follows the hornbill and praying-mantis (wenet) forms,
  not human figures.
- Only Pinto Aceh has a verified WBTB listing (2015); captions state WBTB only
  where verified.
- Known gaps (deliberately deferred): Palembang songket, Lampung tapis,
  Bengkulu besurek, Betawi, Madura, Sasak, Minahasa, Bugis-Makassar, Gorontalo
  karawo, North Maluku. Adding one later is one list entry, one image, one
  caption.

## Rendering

### Placement

- **Outside the app shell** (sign-in, setup, forgot/reset password, invite,
  error, not-found): the unauthenticated wrapper in `app/[locale]/layout.tsx`
  renders the motif upright in the bottom-end corner and rotated 180° in the
  top-start corner (mirrored in RTL). Below 640px only the bottom one shows.
- **Size**: `min(60vw, 14rem)` below 640px, `min(36vw, 60vh, 26rem)` (≤ 416px)
  from 640px up. The height cap keeps short viewports from filling with
  ornament.
- **Sidebar**: one copy at the same size as the sign-in ornament (the component
  owns its size), anchored to the bottom-start corner (the screen edge,
  mirrored as needed), reaching the bottom behind the user menu, clipped to the
  sidebar, behind the menu items. Hidden when the sidebar collapses to icons.

### Colour

A `<div>` with `mask-image: url(/motifs/<slug>.webp)` (no-repeat, contain,
anchored to its corner) and `background-color: var(--primary)`, so one asset
serves every accent × light/dark and repaints instantly when the accent
changes. Opacity ≈6% light, ≈8% dark — final values tuned during visual QA;
text contrast is unaffected. Decorative: `aria-hidden`,
`pointer-events: none`, `print:hidden`. Outside the app shell the accent is the
brand default (no user).

### Assets

- Source PNGs (black on transparent, 1024², from the brainstorming probe) and
  their prompts live in `design/motifs/` (`<slug>.png`, `prompts.json`).
- `scripts/build-motifs.mjs` (run with Node — sharp hangs under Bun here)
  extracts the alpha channel and writes `public/motifs/<slug>.webp`. The WebP
  files are committed so the Docker build needs no image tooling.
- Replacing a motif = replace its PNG, rerun the script. Pa' Barre Allo,
  Tenun Tanimbar and Patra Punggel are "acceptable" and may be regenerated
  later without code changes.

## Choosing a motif

### Data (`lib/motifs.ts`)

- `MOTIFS`: the 11 entries above in order — `slug`, `longitude`,
  `sourceUrl`.
- `MotifPreference = "daily" | "none" | MotifSlug`; `motifPreferenceSchema`
  (zod).
- `effectiveMotifPreference(user)`: stored value, or `daily` for null/unknown
  (same fallback idea as `effectiveAccent`).
- `dailyMotif(date)`: `MOTIFS[daysSinceEpoch(date in APP_TIMEZONE) % 11]` —
  everyone sees the same motif on the same WIB day; it changes at WIB
  midnight. A page left open past midnight changes on its next full load or refresh.
- `resolveMotif(pref, date)`: `null` for `none`, the pinned slug, or the daily
  one.

### Storage

- New nullable column `users.motif text` (`NULL` = daily). Migration
  `drizzle/20261014000000_user_motif/migration.sql`, no backfill. Registered
  in better-auth `additionalFields` with `input: false`.
- `setMotif(pref)` in `actions/profile.ts`: zod-validated, stores `daily` as
  `NULL`, `revalidatePath` like `setAccentColor`.
- Rollout: backup → dry-run → apply on live **before** deploying the build.

### Picker

- User menu, below Theme and Accent: submenu **Motif** with
  - "About <motif>…" (hidden when the preference is `none`),
  - radio items: **Daily** (subtitle: today's motif), **None**, then the 11
    motifs, each with its region as a subtitle.
- Command palette: "Motif: …" entries for every option, like the accent ones.
- Optimistic like the accent: repaint at once, save in the background, latest
  choice wins, rollback + toast on failure. The latest-wins reducer in
  `lib/accent-state.ts` is generalised to `lib/optimistic-preference.ts`
  (generic over the value type) and used by both providers; the existing
  accent tests move with it and guard the refactor.
- A `MotifProvider` holds the preference client-side; the sidebar watermark
  and the menu read it.

## Cultural note

- Content per motif in `messages/*.json` (namespace `motifs`, all 5 locales):
  `region`, `medium`, `meaning` (2–3 sourced sentences), optional `localName`.
  Titles are proper nouns and stay the same in every locale. `sourceUrl`
  lives in `lib/motifs.ts`.
- Every note ends with: "This illustration is an AI interpretation of the
  motif, not a reproduction of an artefact."
- One `MotifInfo` component renders it:
  - outside the app shell: a small text button in the existing footer row
    ("ⓘ Kawung · Yogyakarta") opening a popover;
  - in the app: the "About <motif>…" menu item opening a dialog.
- id and en are written from the research; es, zh and ar are translated from
  en.

## Testing

- `tests/motifs.test.ts`: longitudes strictly increase (west → east);
  `dailyMotif` is deterministic and flips exactly at WIB midnight and cycles
  every 11 days; unknown/null preference → `daily`; schema accepts exactly
  `daily`, `none` and the slugs; `resolveMotif` cases.
- Asset test: every slug has `public/motifs/<slug>.webp` and there are no
  orphan files.
- i18n test: every motif has every caption key in all 5 locales.
- `tests/optimistic-preference.test.ts`: the moved accent cases plus a motif
  case.
- Gates: Biome, tsc, `bun test`, build exit code; visual QA in headless
  Chrome (light/dark × a few accents, sign-in and sidebar).

## Out of scope

Animated motifs, per-page motifs, user-tunable size/opacity, more regions
(see gaps above).
