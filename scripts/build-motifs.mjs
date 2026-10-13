// Build the motif masks the app serves from the generated source art.
// Each design/motifs/<slug>.png (black on transparent) becomes
// public/motifs/<slug>.webp: black RGB plus the source's alpha channel, which
// is all CSS mask-image reads. The source art has uneven transparent margins,
// so the script trims them and anchors the art to the bottom-right of the
// canvas: every ornament sits flush in its corner. After writing each WebP it
// reads it back and fails unless the art touches the bottom row and right
// column. Run with Node — sharp hangs under Bun here:
//   node scripts/build-motifs.mjs
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const SRC = "design/motifs";
const OUT = "public/motifs";
const SIZE = 1024;

await mkdir(OUT, { recursive: true });
for (const file of (await readdir(SRC)).filter((f) => f.endsWith(".png"))) {
  const slug = path.basename(file, ".png");
  const trimmed = await sharp(path.join(SRC, file))
    .ensureAlpha()
    .trim({ threshold: 10 })
    .toBuffer();
  const alpha = await sharp(trimmed)
    .resize(SIZE, SIZE, {
      fit: "contain",
      position: "right bottom",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer();
  const out = path.join(OUT, `${slug}.webp`);
  await sharp({
    create: { width: SIZE, height: SIZE, channels: 3, background: "#000" },
  })
    .joinChannel(alpha, { raw: { width: SIZE, height: SIZE, channels: 1 } })
    .webp({ quality: 70, alphaQuality: 80, effort: 6 })
    .toFile(out);

  const back = await sharp(out)
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer();
  let bottom = false;
  let right = false;
  for (let i = 0; i < SIZE; i++) {
    if (back[(SIZE - 1) * SIZE + i] > 0) bottom = true;
    if (back[i * SIZE + SIZE - 1] > 0) right = true;
  }
  if (!(bottom && right)) {
    throw new Error(`${slug}: art is not flush with the bottom/right edges`);
  }
  console.log(slug);
}
