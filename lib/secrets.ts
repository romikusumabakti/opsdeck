import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// App-level encryption for secrets at rest: SSH/DB passwords, the mssql `sa`
// password, S3 secret keys, and the mock-time API key. AES-256-GCM under a
// single master key from `process.env.SECRETS_KEY` (base64, 32 bytes — generate
// with `openssl rand -base64 32`).
//
// Ciphertext format: `enc:v1:<base64(iv(12) | tag(16) | ciphertext)>`.
// The `enc:v1:` prefix is BOTH the version tag and the discriminator that lets
// `decryptSecret` tell ciphertext apart from pre-encryption plaintext — so the
// rollout needs no data migration: existing plaintext rows decrypt to
// themselves and get re-enveloped the next time they're written.

const PREFIX = "enc:v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey: Buffer | null = null;

function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.SECRETS_KEY;
  if (!raw) {
    throw new Error(
      "SECRETS_KEY is not set — required to encrypt/decrypt secrets at rest. " +
        "Generate one with: openssl rand -base64 32"
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `SECRETS_KEY must decode to 32 bytes (got ${key.length}). ` +
        "Generate one with: openssl rand -base64 32"
    );
  }
  cachedKey = key;
  return key;
}

/** True if `value` is a stored ciphertext envelope (vs. legacy plaintext). */
export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Encrypt a plaintext secret into the `enc:v1:` envelope. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

/**
 * Decrypt a stored secret. Tolerant by design: a value WITHOUT the `enc:v1:`
 * prefix is treated as legacy plaintext (a row written before encryption) and
 * returned verbatim, so reads keep working during the rollout.
 */
export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext
  const buf = Buffer.from(stored.slice(PREFIX.length), "base64");
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Encrypt an optional secret column. Null/undefined/empty pass through
 * unchanged — presence flags (hasDbPassword, hasSecret…) key off emptiness, so
 * "no secret" must stay literally empty, not an envelope over "".
 */
export function encryptNullable<T extends string | null | undefined>(v: T): T {
  if (v == null || v === "") return v;
  return encryptSecret(v) as T;
}

/** Decrypt an optional secret column; null/undefined pass through. */
export function decryptNullable<T extends string | null | undefined>(v: T): T {
  if (v == null) return v;
  return decryptSecret(v) as T;
}
