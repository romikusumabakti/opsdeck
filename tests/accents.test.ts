import { afterEach, describe, expect, it } from "vitest";
import {
  ACCENTS,
  accentSchema,
  brandIconSrc,
  defaultAccent,
  effectiveAccent,
  isAccent,
} from "@/lib/accents";

const saved = process.env.BRAND;
afterEach(() => {
  if (saved === undefined) delete process.env.BRAND;
  else process.env.BRAND = saved;
});

describe("accents", () => {
  it("lists neutral plus shadcn's seven colour themes", () => {
    expect([...ACCENTS]).toEqual([
      "neutral",
      "blue",
      "green",
      "orange",
      "red",
      "rose",
      "violet",
      "yellow",
    ]);
  });

  it("defaults to the brand's accent", () => {
    process.env.BRAND = "dss";
    expect(defaultAccent()).toBe("blue");
    delete process.env.BRAND;
    expect(defaultAccent()).toBe("neutral");
  });

  it("uses a valid stored accent", () => {
    process.env.BRAND = "dss";
    expect(effectiveAccent({ accentColor: "rose" })).toBe("rose");
    expect(effectiveAccent({ accentColor: "neutral" })).toBe("neutral");
  });

  it("falls back to the brand default for null, missing or unknown values", () => {
    process.env.BRAND = "dss";
    expect(effectiveAccent({ accentColor: null })).toBe("blue");
    expect(effectiveAccent({})).toBe("blue");
    expect(effectiveAccent(null)).toBe("blue");
    expect(effectiveAccent({ accentColor: "teal" })).toBe("blue");
    expect(effectiveAccent({ accentColor: "" })).toBe("blue");
  });

  it("validates input to the closed set", () => {
    expect(accentSchema.safeParse("violet").success).toBe(true);
    expect(accentSchema.safeParse("teal").success).toBe(false);
    expect(accentSchema.safeParse(null).success).toBe(false);
    expect(isAccent("blue")).toBe(true);
    expect(isAccent(42)).toBe(false);
  });

  it("builds the favicon URL, with no param meaning the brand default", () => {
    expect(brandIconSrc("rose")).toBe("/brand/icon.svg?accent=rose");
    expect(brandIconSrc()).toBe("/brand/icon.svg");
  });
});
