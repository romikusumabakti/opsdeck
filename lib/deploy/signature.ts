import { createHmac, timingSafeEqual } from "node:crypto";

// Build notifications from CI carry `X-Opsdeck-Signature: sha256=<hex>`, the
// HMAC-SHA256 of the raw request body under the app's notify secret (the
// GitHub webhook convention, so `openssl dgst -sha256 -hmac` can produce it).

const SIGNATURE = /^sha256=([0-9a-fA-F]{64})$/;

/**
 * True when `header` is a well-formed signature of `rawBody` under `secret`.
 * The digest comparison is constant-time; a malformed or missing header is
 * refused before any comparison, which leaks only the (public) format.
 */
export function verifySignature(
  rawBody: string,
  header: string | undefined,
  secret: string
): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const match = header === undefined ? null : SIGNATURE.exec(header);
  if (!match?.[1]) return false;
  const provided = Buffer.from(match[1], "hex");
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}
