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
  for (const [, name = "", value = ""] of body.matchAll(
    /--([\w-]+):\s*([^;]+);/g
  )) {
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
  if (!m?.[1] || !m[3] || !m[4])
    throw new Error(`not an opaque oklch(): ${value}`);
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
      expect(binding["tint-ring-light"]).toBe(
        `var(--color-${accent}-${steps.ringLight})`
      );
      expect(binding["tint-ring-dark"]).toBe(
        `var(--color-${accent}-${steps.ringDark})`
      );
    }
  });

  it("bind every --tint-* to the accent's own palette", () => {
    for (const accent of TINTED) {
      const binding = must(block(`[data-accent="${accent}"]`), accent);
      const tints = Object.entries(binding).filter(([n]) =>
        n.startsWith("tint-")
      );
      expect(tints.length).toBeGreaterThan(0);
      for (const [name, value] of tints) {
        expect({
          accent,
          name,
          own: value.startsWith(`var(--color-${accent}-`),
        }).toEqual({ accent, name, own: true });
      }
    }
  });

  it("point the logo at the logo steps and the status tile at the ring", () => {
    expect(ROLE_LIGHT["logo-status"]).toBe("var(--tint-ring-light)");
    expect(ROLE_DARK["logo-status"]).toBe("var(--tint-ring-dark)");
    for (const accent of TINTED) {
      const binding = must(block(`[data-accent="${accent}"]`), accent);
      const steps = ACCENT_STEPS[accent];
      // The role blocks name a fixed tint; it must be the step the favicon uses.
      expect(ROLE_LIGHT.logo).toBe("var(--tint-900)");
      expect(binding["tint-900"]).toBe(
        `var(--color-${accent}-${steps.logoLight})`
      );
      expect(ROLE_DARK.logo).toBe("var(--tint-200)");
      expect(binding["tint-200"]).toBe(
        `var(--color-${accent}-${steps.logoDark})`
      );
    }
  });

  for (const accent of TINTED) {
    for (const mode of ["light", "dark"] as const) {
      it(`${accent} (${mode}) keeps text at AA and the ring at 3:1`, () => {
        const binding = must(block(`[data-accent="${accent}"]`), accent);
        const scopes =
          mode === "light"
            ? [ROLE_LIGHT, binding, ROOT]
            : [ROLE_DARK, binding, DARK, ROOT];
        const token = (name: string) => resolve(`var(--${name})`, scopes);
        const results = {
          "primary-foreground on primary": contrast(
            token("primary-foreground"),
            token("primary")
          ),
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
