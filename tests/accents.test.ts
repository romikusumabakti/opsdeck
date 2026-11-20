import { describe, expect, it } from "vitest";
import {
  ACCENTS,
  accentSchema,
  type BootstrapIcon,
  brandIconSrc,
  effectiveAccent,
  isAccent,
} from "@/lib/accents";

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

  it("uses a valid stored accent", () => {
    expect(effectiveAccent({ accentColor: "rose" }, "blue")).toBe("rose");
    expect(effectiveAccent({ accentColor: "neutral" }, "blue")).toBe("neutral");
  });

  it("falls back to the instance accent", () => {
    expect(effectiveAccent(null, "blue")).toBe("blue");
    expect(effectiveAccent({ accentColor: "teal" }, "green")).toBe("green");
    expect(effectiveAccent({ accentColor: null }, "rose")).toBe("rose");
    expect(effectiveAccent({}, "neutral")).toBe("neutral");
    expect(effectiveAccent({ accentColor: "" }, "violet")).toBe("violet");
  });

  it("validates input to the closed set", () => {
    expect(accentSchema.safeParse("violet").success).toBe(true);
    expect(accentSchema.safeParse("teal").success).toBe(false);
    expect(accentSchema.safeParse(null).success).toBe(false);
    expect(isAccent("blue")).toBe(true);
    expect(isAccent(42)).toBe(false);
  });

  it("brandIconSrc adds the accent only to the default icon", () => {
    const builtIn: BootstrapIcon = {
      src: "/brand/icon.svg",
      type: "image/svg+xml",
      custom: false,
    };
    expect(brandIconSrc(builtIn, "rose")).toBe("/brand/icon.svg?accent=rose");
    expect(brandIconSrc(builtIn)).toBe("/brand/icon.svg");
    const svg: BootstrapIcon = {
      src: "/brand/icon.svg?v=kx1",
      type: "image/svg+xml",
      custom: true,
    };
    expect(brandIconSrc(svg, "rose")).toBe("/brand/icon.svg?v=kx1");
    const png: BootstrapIcon = {
      src: "/brand/icon.png?v=kx1",
      type: "image/png",
      custom: true,
    };
    expect(brandIconSrc(png, "rose")).toBe("/brand/icon.png?v=kx1");
  });
});
