import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateBrandLogo } from "@/lib/brand-logo-validate";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(__dirname, "fixtures/branding", name)));

// A 1×1 PNG, the seed every raster input is resized from.
const SEED = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);
// A 1×1 GIF89a: GIF has no encoder in Bun.Image.
const GIF = new Uint8Array(
  Buffer.from(
    "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==",
    "base64"
  )
);

function raster(
  width: number,
  height: number,
  format: "png" | "webp" | "jpeg" = "png"
): Promise<Uint8Array> {
  const image = new Bun.Image(SEED).resize(width, height);
  if (format === "webp") return image.webp({ lossless: true }).bytes();
  if (format === "jpeg") return image.jpeg().bytes();
  return image.png().bytes();
}

const encoder = new TextEncoder();
const svg = (viewBox: string, extra = "") =>
  encoder.encode(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${extra}<rect width="1" height="1"/></svg>`
  );

describe("validateBrandLogo", () => {
  it("detects type from content: PNG bytes named .svg are PNG", async () => {
    // There is no name or declared type to read: only the bytes count.
    const result = await validateBrandLogo(await raster(128, 128));
    expect(result).toMatchObject({ ok: true, type: "image/png" });
    const logo = await validateBrandLogo(fixture("logo.svg"));
    expect(logo).toMatchObject({ ok: true, type: "image/svg+xml" });
  });

  it("detects an SVG after a BOM, an XML declaration or whitespace", async () => {
    const body = new TextDecoder().decode(fixture("logo.svg"));
    for (const prefix of ["﻿", '<?xml version="1.0"?>\n', "\n  "]) {
      const result = await validateBrandLogo(encoder.encode(prefix + body));
      expect(result).toMatchObject({ ok: true, type: "image/svg+xml" });
    }
  });

  it("rejects JPEG and GIF as unsupported_type", async () => {
    expect(await validateBrandLogo(await raster(128, 128, "jpeg"))).toEqual({
      ok: false,
      error: "unsupported_type",
    });
    expect(await validateBrandLogo(GIF)).toEqual({
      ok: false,
      error: "unsupported_type",
    });
  });

  it("rejects bytes that are not an image as invalid_image", async () => {
    expect(
      await validateBrandLogo(encoder.encode("just some text, not an image"))
    ).toEqual({ ok: false, error: "invalid_image" });
  });

  it("rejects an SVG over 100 KB and a raster over 512 KB as too_large", async () => {
    const bigSvg = svg("0 0 10 10", `<!--${"x".repeat(102_400)}-->`);
    expect(await validateBrandLogo(bigSvg)).toEqual({
      ok: false,
      error: "too_large",
    });
    const png = await raster(128, 128);
    const bigPng = new Uint8Array(524_289);
    bigPng.set(png);
    expect(await validateBrandLogo(bigPng)).toEqual({
      ok: false,
      error: "too_large",
    });
  });

  it("rejects 1100×1100 as too_large_dimensions and 32×32 as too_small", async () => {
    expect(await validateBrandLogo(await raster(1100, 1100))).toEqual({
      ok: false,
      error: "too_large_dimensions",
    });
    expect(await validateBrandLogo(await raster(32, 32))).toEqual({
      ok: false,
      error: "too_small",
    });
  });

  it("accepts 100×104 and rejects 100×110 and wide.svg as not_square", async () => {
    expect(await validateBrandLogo(await raster(100, 104))).toMatchObject({
      ok: true,
    });
    expect(await validateBrandLogo(await raster(100, 110))).toEqual({
      ok: false,
      error: "not_square",
    });
    expect(await validateBrandLogo(fixture("wide.svg"))).toEqual({
      ok: false,
      error: "not_square",
    });
  });

  it("reads an SVG's aspect from width/height without a viewBox, and needs one of them", async () => {
    const sized = encoder.encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="1" height="1"/></svg>'
    );
    expect(await validateBrandLogo(sized)).toMatchObject({ ok: true });
    const bare = encoder.encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'
    );
    expect(await validateBrandLogo(bare)).toEqual({
      ok: false,
      error: "invalid_image",
    });
  });

  it("stores the sanitized SVG, and rejects a DOCTYPE as invalid_image", async () => {
    const result = await validateBrandLogo(
      svg("0 0 10 10", "<script>alert(1)</script>")
    );
    if (!result.ok) throw new Error(result.error);
    expect(new TextDecoder().decode(result.bytes)).not.toContain("script");
    expect(await validateBrandLogo(fixture("doctype.svg"))).toEqual({
      ok: false,
      error: "invalid_image",
    });
  });

  it("re-encodes PNG and WebP", async () => {
    for (const format of ["png", "webp"] as const) {
      const input = await raster(96, 96, format);
      const result = await validateBrandLogo(input);
      if (!result.ok) throw new Error(result.error);
      expect(result.type).toBe(`image/${format}`);
      expect(result.bytes).not.toBe(input);
      const meta = await new Bun.Image(result.bytes).metadata();
      expect(meta).toMatchObject({ width: 96, height: 96, format });
    }
  });
});
