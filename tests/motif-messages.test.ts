import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { routing } from "@/i18n/routing";
import { MOTIF_SLUGS } from "@/lib/motifs";

type Motifs = Record<string, unknown> & {
  items: Record<string, Record<string, string>>;
};

function motifs(locale: string): Motifs {
  return JSON.parse(readFileSync(`messages/${locale}.json`, "utf8")).motifs;
}

const KEYS = ["region", "medium", "meaning"];

describe("motifs messages", () => {
  const en = motifs("en");

  for (const locale of routing.locales) {
    it(`${locale} has every motifs key`, () => {
      const m = motifs(locale);
      expect(Object.keys(m).sort()).toEqual(Object.keys(en).sort());
      expect(Object.keys(m.items).sort()).toEqual([...MOTIF_SLUGS].sort());
      for (const slug of MOTIF_SLUGS) {
        for (const key of KEYS) {
          expect(m.items[slug]?.[key]?.trim().length ?? 0).toBeGreaterThan(0);
        }
      }
      expect(String(m.about)).toContain("{name}");
      expect(String(m.localName)).toContain("{name}");
    });
  }
});
