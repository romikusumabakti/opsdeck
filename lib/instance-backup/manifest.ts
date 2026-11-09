// The manifest of an instance backup: what it holds and how to check it.
// Written last, so a backup folder without one is incomplete. It never holds
// SECRETS_KEY, only its fingerprint, so an admin can check that the key they
// kept offline is the one a restore needs.
import { createHash } from "node:crypto";
import { z } from "zod";

export const MANIFEST_FILE = "manifest.json";
export const DATABASE_FILE = "database.dump";
export const GARAGE_DIR = "garage";

export type BackupManifest = {
  format: 1;
  /** OPSDECK_VERSION the backup was taken from; a restore runs under it. */
  version: string;
  /** ISO 8601, UTC. */
  createdAt: string;
  /** The `pg_dump -Fc` of DATABASE_URL. */
  database: { file: string; sha256: string; bytes: number };
  /** The Garage bucket mirror under garage/. */
  garage: { objects: number; bytes: number };
  secretsKeyFingerprint: string;
};

const count = z.number().int().nonnegative();

const manifestSchema = z.object({
  format: z.literal(1),
  version: z.string().min(1),
  createdAt: z.iso.datetime(),
  database: z.object({
    file: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: count,
  }),
  garage: z.object({ objects: count, bytes: count }),
  secretsKeyFingerprint: z.string().regex(/^[0-9a-f]{16}$/),
});

/** sha256 of the key, truncated to 16 hex characters. Safe to store and show. */
export function secretsKeyFingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function serializeManifest(manifest: BackupManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Parses and validates a manifest; throws on anything else. */
export function parseManifest(text: string): BackupManifest {
  return manifestSchema.parse(JSON.parse(text));
}
