// Build the motif masks the app serves from the generated source art.
// Each design/motifs/<slug>.png (black on transparent) becomes
// public/motifs/<slug>.webp: black RGB plus the source's alpha channel, which
// is all CSS mask-image reads. Run with Node — sharp hangs under Bun here:
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
  const alpha = await sharp(path.join(SRC, file))
    .resize(SIZE, SIZE, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer();
  await sharp({
    create: { width: SIZE, height: SIZE, channels: 3, background: "#000" },
  })
    .joinChannel(alpha, { raw: { width: SIZE, height: SIZE, channels: 1 } })
    .webp({ quality: 70, alphaQuality: 80, effort: 6 })
    .toFile(path.join(OUT, `${slug}.webp`));
  console.log(slug);
}
