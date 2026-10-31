import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "@/lib/contrast";

// Secondary text must stay readable (WCAG AA 4.5:1) on every surface it sits
// on. Accent themes never override these tokens, so :root and .dark cover
// every accent.

const css = readFileSync(
  join(import.meta.dirname, "../web/styles.css"),
  "utf8"
);

function tokens(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = css.match(
    new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`)
  )?.[1];
  if (body === undefined) throw new Error(`${selector} block not found`);
  const out: Record<string, string> = {};
  for (const [, name = "", value = ""] of body.matchAll(
    /--([\w-]+):\s*([^;]+);/g
  )) {
    out[name] = value.trim();
  }
  return out;
}

const SURFACES = ["background", "card", "muted", "sidebar"];

describe("muted text contrast", () => {
  for (const [mode, selector] of [
    ["light", ":root"],
    ["dark", ".dark"],
  ] as const) {
    for (const surface of SURFACES) {
      it(`muted-foreground on ${surface} (${mode}) is at least 4.5:1`, () => {
        const scope = { ...tokens(":root"), ...tokens(selector) };
        const fg = scope["muted-foreground"];
        const bg = scope[surface];
        if (!(fg && bg)) throw new Error("token missing");
        expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
