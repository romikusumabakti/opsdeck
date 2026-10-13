import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import {
  dailyMotif,
  effectiveMotifPreference,
  getMotif,
  isMotifSlug,
  MOTIF_SLUGS,
  MOTIFS,
  motifPreferenceSchema,
  motifSrc,
  resolveMotif,
  storedMotif,
} from "@/lib/motifs";

const WIB = "Asia/Jakarta";

describe("MOTIFS", () => {
  it("runs west to east", () => {
    for (let i = 1; i < MOTIFS.length; i++) {
      expect(MOTIFS[i]!.longitude).toBeGreaterThan(MOTIFS[i - 1]!.longitude);
    }
  });

  it("has eleven unique slugs", () => {
    expect(MOTIFS).toHaveLength(11);
    expect(new Set(MOTIF_SLUGS).size).toBe(11);
  });

  it("links every motif to an https source", () => {
    for (const m of MOTIFS) expect(m.sourceUrl).toStartWith("https://");
  });
});

describe("dailyMotif", () => {
  it("pins the rotation to the calendar", () => {
    expect(dailyMotif(new Date("2026-10-14T05:00:00Z"), WIB)).toBe(
      "batang-garing"
    );
  });

  it("is the same all day in WIB", () => {
    expect(dailyMotif(new Date("2026-10-13T17:00:00Z"), WIB)).toBe(
      dailyMotif(new Date("2026-10-14T16:59:59Z"), WIB)
    );
  });

  // Prod runs in UTC: the flip must be at 00:00 WIB = 17:00 UTC.
  it("moves to the next motif at WIB midnight, not UTC midnight", () => {
    const before = dailyMotif(new Date("2026-10-13T16:59:59Z"), WIB);
    const after = dailyMotif(new Date("2026-10-13T17:00:00Z"), WIB);
    const i = MOTIF_SLUGS.indexOf(before);
    expect(after).toBe(MOTIF_SLUGS[(i + 1) % MOTIF_SLUGS.length]!);
    expect(dailyMotif(new Date("2026-10-14T00:00:00Z"), WIB)).toBe(after);
  });

  it("cycles every eleven days", () => {
    const day = new Date("2026-10-14T05:00:00Z");
    const later = new Date(day.getTime() + 11 * 86_400_000);
    expect(dailyMotif(later, WIB)).toBe(dailyMotif(day, WIB));
  });
});

describe("preferences", () => {
  it("accepts daily, none and every slug, nothing else", () => {
    for (const v of ["daily", "none", ...MOTIF_SLUGS]) {
      expect(motifPreferenceSchema.safeParse(v).success).toBe(true);
    }
    for (const v of ["", "random", "Kawung", null, 3]) {
      expect(motifPreferenceSchema.safeParse(v).success).toBe(false);
    }
  });

  it("falls back to daily for unset or unknown stored values", () => {
    expect(effectiveMotifPreference(null)).toBe("daily");
    expect(effectiveMotifPreference({ motif: null })).toBe("daily");
    expect(effectiveMotifPreference({ motif: "removed-motif" })).toBe("daily");
    expect(effectiveMotifPreference({ motif: "none" })).toBe("none");
    expect(effectiveMotifPreference({ motif: "kawung" })).toBe("kawung");
  });

  it("stores daily as null", () => {
    expect(storedMotif("daily")).toBeNull();
    expect(storedMotif("none")).toBe("none");
    expect(storedMotif("mamuli")).toBe("mamuli");
  });

  it("resolves the motif to show", () => {
    expect(resolveMotif("daily", "gorga")).toBe("gorga");
    expect(resolveMotif("none", "gorga")).toBeNull();
    expect(resolveMotif("kawung", "gorga")).toBe("kawung");
  });

  it("recognises slugs", () => {
    expect(isMotifSlug("ukiran-asmat")).toBe(true);
    expect(isMotifSlug("daily")).toBe(false);
  });

  it("finds a motif and its mask", () => {
    expect(getMotif("pintu-aceh").localName).toBe("Pinto Aceh");
    expect(motifSrc("kawung")).toBe("/motifs/kawung.webp");
  });
});

describe("motif assets", () => {
  it("has a mask for every motif and no orphans", () => {
    const files = readdirSync("public/motifs").sort();
    expect(files).toEqual(MOTIF_SLUGS.map((s) => `${s}.webp`).sort());
  });

  it("has source art for every motif", () => {
    for (const slug of MOTIF_SLUGS) {
      expect(existsSync(`design/motifs/${slug}.png`)).toBe(true);
    }
  });
});
