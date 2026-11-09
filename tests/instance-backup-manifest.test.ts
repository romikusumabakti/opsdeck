import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type BackupManifest,
  parseManifest,
  secretsKeyFingerprint,
  serializeManifest,
} from "@/lib/instance-backup/manifest";

const manifest: BackupManifest = {
  format: 1,
  version: "1.2.3",
  createdAt: "2026-11-09T02:30:00.000Z",
  database: { file: "database.dump", sha256: "a".repeat(64), bytes: 1234 },
  garage: { objects: 2, bytes: 99 },
  secretsKeyFingerprint: "0123456789abcdef",
};

describe("backup manifest", () => {
  it("round-trips", () => {
    expect(parseManifest(serializeManifest(manifest))).toEqual(manifest);
  });

  it("rejects an unknown format", () => {
    const text = JSON.stringify({ ...manifest, format: 2 });
    expect(() => parseManifest(text)).toThrow();
  });

  it("fingerprints a key as the first 16 hex characters of its sha256", () => {
    const sha = createHash("sha256").update("abc").digest("hex");
    expect(secretsKeyFingerprint("abc")).toBe(sha.slice(0, 16));
    expect(secretsKeyFingerprint("abc")).toBe("ba7816bf8f01cfea");
  });
});
