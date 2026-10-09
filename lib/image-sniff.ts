// Magic-byte sniff -> { ext, mime }. The bytes are the source of truth, so a
// spoofed extension/Content-Type can't smuggle in a non-image. SVG is rejected
// by omission (active XSS vector); anything imgproxy can't render is rejected on
// serve anyway, but we refuse to even store junk.
export function sniffImage(buf: Buffer): { ext: string; mime: string } | null {
  const b = buf;
  if (b.length < 12) return null;
  // PNG: 89 50 4E 47
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { ext: "png", mime: "image/png" };
  }
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  // GIF: "GIF8"
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return { ext: "gif", mime: "image/gif" };
  }
  // WebP: "RIFF"...."WEBP"
  if (
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { ext: "webp", mime: "image/webp" };
  }
  // AVIF/HEIF: "ftyp" box at offset 4 with an avif/avis brand
  if (b.toString("ascii", 4, 8) === "ftyp") {
    const brand = b.toString("ascii", 8, 12);
    if (brand === "avif" || brand === "avis") {
      return { ext: "avif", mime: "image/avif" };
    }
  }
  return null;
}
