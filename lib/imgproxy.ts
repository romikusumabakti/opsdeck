import "server-only";

import { createHmac } from "node:crypto";

// Build signed imgproxy URLs. imgproxy (a dedicated, internal-only container)
// pulls the original object straight from Garage (s3://…), re-renders it on the
// fly, and returns a resized, modern-format image. Keeping it out of the app
// means no native module (sharp/libvips) ships in the Next bundle — the whole
// class of "libvips .so missing in the standalone Docker image" problem is gone.
//
// The signature (HMAC-SHA256 over salt+path, base64url) lets imgproxy reject any
// URL the app didn't mint. Auth itself stays at the app: the /api/knowledge/
// asset/<id> route checks the session, then fetches a freshly-signed URL from
// imgproxy server-side, so imgproxy is never exposed to the browser.

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const hex = (s: string) => Buffer.from(s, "hex");

/**
 * Signed imgproxy URL for an attachment's storage key. `rs:fit:W:0` downscales
 * to a max width without upscaling; format is negotiated by imgproxy from the
 * forwarded Accept header (AVIF → WebP → original), so callers pass the browser
 * Accept through and get the most modern format it supports.
 */
export function imgproxyUrl(
  storageKey: string,
  { width = 1600, quality = 82 } = {}
): string {
  const source = `s3://${env("S3_BUCKET")}/${storageKey}`;
  const encoded = Buffer.from(source).toString("base64url");
  const path = `/rs:fit:${width}:0/q:${quality}/${encoded}`;

  const signature = createHmac("sha256", hex(env("IMGPROXY_KEY")))
    .update(hex(env("IMGPROXY_SALT")))
    .update(path)
    .digest("base64url");

  return `${env("IMGPROXY_URL")}/${signature}${path}`;
}
