import { ACCENT_PALETTE } from "@/lib/accent-palette";
import type { AccentColor } from "@/lib/accents";

/**
 * The built-in Menara mark, shown while the instance has no uploaded logo: a
 * four-tile dashboard grid — top-left, top-right, bottom-left, and the
 * bottom-right "status" tile that animates while runs are active (motion in
 * web/styles.css). Colour comes from the accent: --logo / --logo-status in the
 * app, ACCENT_PALETTE for the favicon.
 *
 * Geometry is drawn twice, each on a whole-pixel grid for the sizes it is shown
 * at, so no edge lands on half a pixel and blurs:
 *   - 24 units (tile 10, gap 4) for the in-app logo, rendered at 24px;
 *   - 16 units (tile 7, gap 2) for the favicon, shown at 16 and 32px.
 */

type Tiles = { tl: string; tr: string; bl: string; br: string };
type Colors = { fg: string; status: string };

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

/** Four tiles with the same corner radius. */
function grid({ tile: s, gap, radius: r }: Grid): Tiles {
  const far = s + gap;
  const corners: [number, number, number, number] = [r, r, r, r];
  return {
    tl: tilePath(0, 0, s, corners),
    tr: tilePath(far, 0, s, corners),
    bl: tilePath(0, far, s, corners),
    br: tilePath(far, far, s, corners),
  };
}

/** The in-app mark's tiles, on the 24-unit grid. */
export function logoTiles(): Tiles {
  return grid(GRID_24);
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
export function renderBrandIcon(accent: AccentColor): string {
  const t = grid(GRID_16);
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
