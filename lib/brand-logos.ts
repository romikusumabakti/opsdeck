import type { BrandLogoName } from "@/lib/branding";

/**
 * The logos a deployment can pick with BRAND_LOGO. Every logo is the same
 * four-tile grid — top-left, top-right, bottom-left, and the bottom-right
 * "status" tile that animates while runs are active — so the motion in
 * globals.css works for all of them and only shape and colour differ.
 *
 * Geometry is drawn twice, each on a whole-pixel grid for the sizes it is shown
 * at, so no edge lands on half a pixel and blurs:
 *   - 24 units (tile 10, gap 4) for the in-app logo, rendered at 24px;
 *   - 16 units (tile 7, gap 2) for the favicon, shown at 16 and 32px.
 */

type Tiles = { tl: string; tr: string; bl: string; br: string };
type Colors = { fg: string; status: string };

type LogoDef = {
  tiles: (unit: Grid) => Tiles;
  /** Tailwind fill classes for the in-app logo, following the app theme. */
  fill: Colors;
  /** Favicon colours, following the browser's scheme (it can't see the app's). */
  icon: { light: Colors; dark: Colors };
};

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

export const BRAND_LOGO_DEFS: Record<BrandLogoName, LogoDef> = {
  // Neutral product mark: a plain dashboard grid in the theme's text colour.
  default: {
    tiles: (g) => grid(g, { tr: g.radius, br: g.radius }),
    fill: { fg: "fill-foreground", status: "fill-foreground/40" },
    icon: {
      light: { fg: "#171717", status: "rgba(23,23,23,.4)" },
      dark: { fg: "#fafafa", status: "rgba(250,250,250,.4)" },
    },
  },
  // DSS Panel: the right-hand tiles round their outer corners into a "D".
  // DSS Consulting navy in light mode, a navy-tinted white in dark mode.
  dss: {
    tiles: (g) => grid(g, { tr: g.tile - g.radius, br: g.tile - g.radius }),
    fill: {
      fg: "fill-[#203864] dark:fill-[#e8edf6]",
      status: "fill-[#3f72d6] dark:fill-[#7fa8ee]",
    },
    icon: {
      light: { fg: "#203864", status: "#3f72d6" },
      dark: { fg: "#e8edf6", status: "#7fa8ee" },
    },
  },
};

export function logoTiles(logo: BrandLogoName): Tiles {
  return BRAND_LOGO_DEFS[logo].tiles(GRID_24);
}

/** The favicon: static, on the 16-unit grid, coloured by the browser scheme. */
export function renderBrandIcon(logo: BrandLogoName): string {
  const { tiles, icon } = BRAND_LOGO_DEFS[logo];
  const t = tiles(GRID_16);
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
