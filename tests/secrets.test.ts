import { beforeAll, describe, expect, it } from "bun:test";
import {
  decryptNullable,
  decryptSecret,
  encryptNullable,
  encryptSecret,
  isEncrypted,
} from "@/lib/secrets";

// A deterministic 32-byte key for the round-trip tests.
beforeAll(() => {
  process.env.SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");
});

describe("secrets encryption", () => {
  it("round-trips a plaintext through encrypt/decrypt", () => {
    const plain = "hunter2-sudo-password";
    const enc = encryptSecret(plain);
    expect(enc).not.toBe(plain);
    expect(isEncrypted(enc)).toBe(true);
    expect(decryptSecret(enc)).toBe(plain);
  });

  it("produces a fresh IV each call (no deterministic ciphertext)", () => {
    const a = encryptSecret("same-input");
    const b = encryptSecret("same-input");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same-input");
    expect(decryptSecret(b)).toBe("same-input");
  });

  it("treats an un-prefixed value as legacy plaintext (self-healing rollout)", () => {
    // A row written before encryption decrypts to itself, so reads keep working.
    expect(isEncrypted("legacy-plaintext")).toBe(false);
    expect(decryptSecret("legacy-plaintext")).toBe("legacy-plaintext");
  });

  it("rejects a tampered ciphertext (GCM auth tag)", () => {
    const enc = encryptSecret("secret");
    // Flip a byte in the base64 body.
    const body = enc.slice("enc:v1:".length);
    const tampered = `enc:v1:${body.slice(0, -2)}${body.slice(-2) === "AA" ? "BB" : "AA"}`;
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("passes null/undefined/empty through the nullable helpers unchanged", () => {
    expect(encryptNullable(null)).toBe(null);
    expect(encryptNullable(undefined)).toBe(undefined);
    expect(encryptNullable("")).toBe("");
    expect(decryptNullable(null)).toBe(null);
    const enc = encryptNullable("api-key");
    expect(isEncrypted(enc as string)).toBe(true);
    expect(decryptNullable(enc)).toBe("api-key");
  });
});
