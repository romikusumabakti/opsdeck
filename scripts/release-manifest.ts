// Writes release.json for a GitHub Release (.github/workflows/release.yml):
//
//   bun scripts/release-manifest.ts --version 1.2.0 \
//     --app ghcr.io/romikusumabakti/opsdeck:1.2.0@sha256:… \
//     --images base-images.env --min-from release/min-from.txt \
//     --assets ops/install --out release.json
//
// --images holds `<key>=<ref>@sha256:…` lines for the non-app images;
// --assets is the dir of the release assets the updater pins with the images
// (compose.yaml, update.sh), recorded by sha256.
// The host updater (ops/install/update.sh) reads release.json with sed/awk and
// no JSON parser, so the output is one compact line without backslashes, and
// every image is pinned by digest the way update.sh's IMAGE_RE accepts.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { compareVersions } from "@/lib/version";

export const IMAGE_KEYS = [
  "app",
  "postgres",
  "valkey",
  "garage",
  "imgproxy",
  "caddy",
] as const;

export type ImageKey = (typeof IMAGE_KEYS)[number];

/** update.sh's RELEASE_ASSETS: downloaded and checked by sha256 on update. */
export const RELEASE_ASSETS = ["compose.yaml", "update.sh"] as const;

export type ReleaseAsset = (typeof RELEASE_ASSETS)[number];

const SHA256_RE = /^[a-f0-9]{64}$/;

const RELEASE_URL = "https://github.com/romikusumabakti/opsdeck/releases/tag";
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$/;
// update.sh's IMAGE_RE; a `latest` tag is never pinned.
export const IMAGE_RE =
  /^[a-z0-9./_-]+(:[A-Za-z0-9._-]+)?@sha256:[a-f0-9]{64}$/;

export function buildReleaseManifest({
  version,
  minFrom,
  images,
  assets,
}: {
  version: string;
  minFrom: string;
  images: Record<ImageKey, string>;
  assets: Record<ReleaseAsset, string>;
}): string {
  if (!VERSION_RE.test(version)) {
    throw new Error(`version ${version} is not X.Y.Z or X.Y.Z-beta.N`);
  }
  if (!VERSION_RE.test(minFrom)) {
    throw new Error(`minFrom ${minFrom} is not X.Y.Z or X.Y.Z-beta.N`);
  }
  if (compareVersions(minFrom, version) > 0) {
    throw new Error(`minFrom ${minFrom} is newer than version ${version}`);
  }
  const pinned = {} as Record<ImageKey, string>;
  for (const key of IMAGE_KEYS) {
    const ref = images[key];
    if (typeof ref !== "string" || !IMAGE_RE.test(ref)) {
      throw new Error(
        `image ${key} is not pinned as <name>:<tag>@sha256:<digest>`
      );
    }
    if (/:latest@/.test(ref)) {
      throw new Error(`image ${key} uses the moving tag latest`);
    }
    pinned[key] = ref;
  }
  if (!pinned.app.includes(`:${version}@`)) {
    throw new Error(`image app is not tagged ${version}`);
  }
  const sums = {} as Record<ReleaseAsset, string>;
  for (const name of RELEASE_ASSETS) {
    const sum = assets[name];
    if (typeof sum !== "string" || !SHA256_RE.test(sum)) {
      throw new Error(`asset ${name} has no sha256`);
    }
    sums[name] = sum;
  }
  const text = JSON.stringify({
    version,
    minFrom,
    images: pinned,
    assets: sums,
    notesUrl: `${RELEASE_URL}/v${version}`,
  });
  // Guaranteed by the checks above; update.sh depends on it.
  if (text.includes("\\") || text.includes("\n")) {
    throw new Error("release.json must be one line without backslashes");
  }
  return text;
}

/** The sha256 of each release asset in <dir>. */
export function assetChecksums(dir: string): Record<ReleaseAsset, string> {
  const sums = {} as Record<ReleaseAsset, string>;
  for (const name of RELEASE_ASSETS) {
    sums[name] = createHash("sha256")
      .update(readFileSync(join(dir, name)))
      .digest("hex");
  }
  return sums;
}

/** `<key>=<ref>` lines; blank lines and `#` comments are skipped. */
export function parseImageLines(
  text: string
): Partial<Record<ImageKey, string>> {
  const images: Partial<Record<ImageKey, string>> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) throw new Error(`not a <key>=<ref> line: ${line}`);
    const key = line.slice(0, eq);
    if (!(IMAGE_KEYS as readonly string[]).includes(key)) {
      throw new Error(`unknown image key ${key}`);
    }
    images[key as ImageKey] = line.slice(eq + 1);
  }
  return images;
}

function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      version: { type: "string" },
      app: { type: "string" },
      images: { type: "string" },
      "min-from": { type: "string" },
      assets: { type: "string" },
      out: { type: "string" },
    },
    strict: true,
  });
  const { version, app, images, assets, out } = values;
  const minFromFile = values["min-from"];
  if (!version || !app || !images || !minFromFile || !assets || !out) {
    console.error(
      "Usage: bun scripts/release-manifest.ts --version X.Y.Z --app <ref> --images <file> --min-from <file> --assets <dir> --out <file>"
    );
    return 1;
  }
  try {
    const text = buildReleaseManifest({
      version,
      minFrom: readFileSync(minFromFile, "utf8").trim(),
      images: {
        ...parseImageLines(readFileSync(images, "utf8")),
        app,
      } as Record<ImageKey, string>,
      assets: assetChecksums(assets),
    });
    writeFileSync(out, `${text}\n`);
    console.log(text);
    return 0;
  } catch (error) {
    console.error(
      `release-manifest: ${error instanceof Error ? error.message : String(error)}`
    );
    return 1;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
