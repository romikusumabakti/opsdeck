import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BRANDS } from "@/lib/branding";

// Every brand's theme must keep text readable: each text/background token pair
// the components actually render must meet WCAG AA for normal text (4.5:1) in
// both modes. Reads the real app/globals.css, so a colour tweak that quietly
// breaks legibility fails here rather than in someone's eyes.

const css = readFileSync(join(import.meta.dir, "../app/globals.css"), "utf8");

/** Custom properties declared in the first block whose selector is exactly `selector`. */
function block(selector: string): Record<string, string> | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  const body = match?.[1];
  if (body === undefined) return undefined;
  const tokens: Record<string, string> = {};
  for (const [, name = "", value = ""] of body.matchAll(
    /--([\w-]+):\s*([^;]+);/g
  )) {
    tokens[name] = value.trim();
  }
  return tokens;
}

function theme(brand: string, mode: "light" | "dark"): Record<string, string> {
  const root = block(":root");
  const dark = block(".dark");
  if (!root || !dark) throw new Error("base theme blocks not found");
  if (brand === "default")
    return mode === "light" ? root : { ...root, ...dark };
  const override =
    mode === "light"
      ? block(`[data-brand="${brand}"]:not(.dark)`)
      : block(`.dark[data-brand="${brand}"]`);
  if (!override) throw new Error(`no ${mode} token block for brand "${brand}"`);
  return mode === "light"
    ? { ...root, ...override }
    : { ...root, ...dark, ...override };
}

/** oklch(L C H) → relative luminance, via OKLab and linear sRGB (clipped). */
function luminance(value: string): number {
  const m = value.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/);
  if (!m) throw new Error(`expected an opaque oklch() colour, got "${value}"`);
  const [L, C, H] = [
    Number(m[1]),
    Number(m[2]),
    (Number(m[3]) * Math.PI) / 180,
  ];
  const a = C * Math.cos(H);
  const b = C * Math.sin(H);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clip = (v: number) => Math.min(1, Math.max(0, v));
  const r = clip(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s);
  const g = clip(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s);
  const bl = clip(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s);
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

function contrast(fg: string, bg: string): number {
  const [x, y] = [luminance(fg), luminance(bg)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function token(tokens: Record<string, string>, name: string): string {
  const value = tokens[name];
  if (value === undefined) throw new Error(`token --${name} is not defined`);
  return value;
}

// Text token on background token, as the components pair them.
// (sidebar-primary is left out: nothing renders it.)
const PAIRS: [string, string][] = [
  ["foreground", "background"],
  ["card-foreground", "card"],
  ["popover-foreground", "popover"],
  ["muted-foreground", "background"],
  ["muted-foreground", "muted"],
  ["muted-foreground", "card"],
  ["primary-foreground", "primary"],
  ["secondary-foreground", "secondary"],
  ["accent-foreground", "accent"],
  ["sidebar-foreground", "sidebar"],
  ["sidebar-accent-foreground", "sidebar-accent"],
];

describe("brand themes", () => {
  it("define light and dark token blocks for every non-default brand", () => {
    for (const brand of BRANDS.filter((b) => b !== "default")) {
      expect(block(`[data-brand="${brand}"]:not(.dark)`)).toBeDefined();
      expect(block(`.dark[data-brand="${brand}"]`)).toBeDefined();
    }
  });

  // `default` is the stock shadcn/ui token set, left as shipped — including its
  // light-mode muted-foreground on muted at 4.34:1. Brands are held to AA.
  for (const brand of BRANDS.filter((b) => b !== "default")) {
    for (const mode of ["light", "dark"] as const) {
      it(`${brand} (${mode}) keeps every text pair at WCAG AA`, () => {
        const tokens = theme(brand, mode);
        const failures = PAIRS.map(([fg, bg]) => ({
          pair: `${fg} on ${bg}`,
          ratio:
            Math.round(contrast(token(tokens, fg), token(tokens, bg)) * 100) /
            100,
        })).filter(({ ratio }) => ratio < 4.5);
        expect(failures).toEqual([]);
      });
    }
  }
});
