import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCENT_PALETTE, ACCENT_STEPS } from "@/lib/accent-palette";

// The favicon can't read CSS variables, so lib/accent-palette.ts copies the
// Tailwind values it needs. This pins the copy to the installed palette: a
// Tailwind upgrade that shifts a colour fails here instead of drifting.
const theme = readFileSync(
  join(import.meta.dirname, "../node_modules/tailwindcss/theme.css"),
  "utf8"
);

function tailwind(name: string): string {
  const match = theme.match(new RegExp(`--color-${name}: (oklch\\([^)]+\\));`));
  if (!match?.[1])
    throw new Error(`--color-${name} not in tailwindcss/theme.css`);
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
