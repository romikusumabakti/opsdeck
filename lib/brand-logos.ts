import { ACCENT_PALETTE } from "@/lib/accent-palette";
import type { AccentColor } from "@/lib/accents";
import type { BrandName } from "@/lib/brands";

/**
 * Logo shapes per brand (BRAND). Every logo is the same four-tile grid — top-
 * left, top-right, bottom-left, and the bottom-right "status" tile that
 * animates while runs are active — so the motion in web/styles.css works for all
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

type Grid = { tile: number; gap: number; radius: number };

const GRID_24: Grid = { tile: 10, gap: 4, radius: 2 };
const GRID_16: Grid = { tile: 7, gap: 2, radius: 1.5 };

/** A square tile at (x, y) with corner radii clockwise from top-left. */
function tilePath(
  x: number,
  y: number,
  s: number,
  [tl, tr, br, bl]: [number, number, number, number]
): string {
  return [
    `M${x + tl} ${y}`,
    `H${x + s - tr}`,
    `A${tr} ${tr} 0 0 1 ${x + s} ${y + tr}`,
    `V${y + s - br}`,
    `A${br} ${br} 0 0 1 ${x + s - br} ${y + s}`,
    `H${x + bl}`,
    `A${bl} ${bl} 0 0 1 ${x} ${y + s - bl}`,
    `V${y + tl}`,
    `A${tl} ${tl} 0 0 1 ${x + tl} ${y}`,
    "Z",
  ].join("");
}

/** Four tiles; `outer` sets the radius of each tile's outermost corner. */
function grid(
  { tile: s, gap, radius: r }: Grid,
  outer: { tr: number; br: number }
): Tiles {
  const far = s + gap;
  return {
    tl: tilePath(0, 0, s, [r, r, r, r]),
    tr: tilePath(far, 0, s, [r, outer.tr, r, r]),
    bl: tilePath(0, far, s, [r, r, r, r]),
    br: tilePath(far, far, s, [r, r, outer.br, r]),
  };
}

export const BRAND_LOGO_DEFS: Record<BrandName, LogoDef> = {
  // Neutral product mark: a plain dashboard grid.
  default: { tiles: (g) => grid(g, { tr: g.radius, br: g.radius }) },
  // DSS Panel: the right-hand tiles round their outer corners into a "D".
  dss: {
    tiles: (g) => grid(g, { tr: g.tile - g.radius, br: g.tile - g.radius }),
  },
};

export function logoTiles(logo: BrandName): Tiles {
  return BRAND_LOGO_DEFS[logo].tiles(GRID_24);
}

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
