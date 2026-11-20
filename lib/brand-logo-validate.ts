import type { LogoType } from "@/lib/instance-branding";
import { sanitizeSvg } from "@/lib/svg-sanitize";

/**
 * Checks an uploaded instance logo (Admin › Instance › Branding) and returns
 * the bytes to store. The type comes from the content only, never from the
 * file name or the declared type: markup is an SVG (sanitized), anything else
 * must decode as PNG or WebP (re-encoded, so nothing but pixels survives).
 * The logo is a square mark: within 5% of 1:1, 64 to 1024 px for raster.
 */

export type LogoError =
  | "too_large"
  | "unsupported_type"
  | "invalid_image"
  | "not_square"
  | "too_small"
  | "too_large_dimensions";

export type LogoValidation =
  | { ok: true; bytes: Uint8Array; type: LogoType }
  | { ok: false; error: LogoError };

export const SVG_LOGO_MAX_BYTES = 102_400;
export const RASTER_LOGO_MAX_BYTES = 524_288;
export const RASTER_LOGO_MIN_SIDE = 64;
export const RASTER_LOGO_MAX_SIDE = 1024;
const MAX_ASPECT = 1.05;

const fail = (error: LogoError): LogoValidation => ({ ok: false, error });

const square = (width: number, height: number) =>
  Math.max(width, height) / Math.min(width, height) <= MAX_ASPECT;

/** Markup: a `<` after an optional BOM and whitespace (`<?xml` starts with one too). */
function looksLikeMarkup(bytes: Uint8Array): boolean {
  let i = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while ([0x20, 0x09, 0x0a, 0x0d].includes(bytes[i] ?? -1)) i++;
  return bytes[i] === 0x3c;
}

const NUMBER = /^\s*([0-9]*\.?[0-9]+)(?:px)?\s*$/;

/** The aspect source of the root <svg>: viewBox, else numeric width/height. */
function svgSize(svg: string): { width: number; height: number } | null {
  const root = /^<svg\b[^>]*>/.exec(svg)?.[0] ?? "";
  const attr = (name: string) =>
    new RegExp(`\\s${name}="([^"]*)"`).exec(root)?.[1];
  const [, , vbWidth = 0, vbHeight = 0, ...rest] =
    attr("viewBox")
      ?.trim()
      .split(/[\s,]+/)
      .map(Number) ?? [];
  if (rest.length === 0 && vbWidth > 0 && vbHeight > 0) {
    return { width: vbWidth, height: vbHeight };
  }
  const width = Number(NUMBER.exec(attr("width") ?? "")?.[1]);
  const height = Number(NUMBER.exec(attr("height") ?? "")?.[1]);
  return width > 0 && height > 0 ? { width, height } : null;
}

async function validateSvg(bytes: Uint8Array): Promise<LogoValidation> {
  if (bytes.length > SVG_LOGO_MAX_BYTES) return fail("too_large");
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("invalid_image");
  }
  const result = await sanitizeSvg(source);
  if (!result.ok) return fail("invalid_image");
  const size = svgSize(result.svg);
  if (!size) return fail("invalid_image");
  if (!square(size.width, size.height)) return fail("not_square");
  // Serializing can grow it (declared namespaces, escaped text).
  const out = new TextEncoder().encode(result.svg);
  if (out.length > SVG_LOGO_MAX_BYTES) return fail("too_large");
  return { ok: true, bytes: out, type: "image/svg+xml" };
}

async function validateRaster(bytes: Uint8Array): Promise<LogoValidation> {
  if (bytes.length > RASTER_LOGO_MAX_BYTES) return fail("too_large");
  const image = () =>
    new Bun.Image(bytes, {
      maxPixels: RASTER_LOGO_MAX_SIDE * RASTER_LOGO_MAX_SIDE,
    });
  let meta: Bun.Image.Metadata;
  try {
    meta = await image().metadata();
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ERR_IMAGE_TOO_MANY_PIXELS") {
      return fail("too_large_dimensions");
    }
    if (code === "ERR_IMAGE_FORMAT_UNSUPPORTED")
      return fail("unsupported_type");
    return fail("invalid_image");
  }
  if (meta.format !== "png" && meta.format !== "webp") {
    return fail("unsupported_type");
  }
  const { width, height } = meta;
  if (Math.max(width, height) > RASTER_LOGO_MAX_SIDE) {
    return fail("too_large_dimensions");
  }
  if (Math.min(width, height) < RASTER_LOGO_MIN_SIDE) return fail("too_small");
  if (!square(width, height)) return fail("not_square");
  let encoded: Uint8Array;
  try {
    encoded =
      meta.format === "png"
        ? await image().png().bytes()
        : await image().webp({ lossless: true }).bytes();
  } catch {
    return fail("invalid_image");
  }
  if (encoded.length > RASTER_LOGO_MAX_BYTES) return fail("too_large");
  return { ok: true, bytes: encoded, type: `image/${meta.format}` };
}

export function validateBrandLogo(bytes: Uint8Array): Promise<LogoValidation> {
  return looksLikeMarkup(bytes) ? validateSvg(bytes) : validateRaster(bytes);
}
