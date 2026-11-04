import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");
});

describe("secrets migration", () => {
  it("planEncryption skips null, empty and already-encrypted values", async () => {
    const { planEncryption } = await import("@/lib/secrets-migration");
    const { encryptSecret } = await import("@/lib/secrets");
    expect(
      planEncryption([
        { id: "1", value: null },
        { id: "2", value: "" },
        { id: "3", value: encryptSecret("x") },
      ])
    ).toEqual([]);
  });

  it("planEncryption encrypts plaintext and the result decrypts back", async () => {
    const { planEncryption } = await import("@/lib/secrets-migration");
    const { decryptSecret, isEncrypted } = await import("@/lib/secrets");
    const [change] = planEncryption([{ id: "1", value: "hunter2" }]) as [
      { id: string; from: string; to: string },
    ];
    expect(change.id).toBe("1");
    expect(change.from).toBe("hunter2");
    expect(isEncrypted(change.to)).toBe(true);
    expect(decryptSecret(change.to)).toBe("hunter2");
  });

  it('a plaintext value starting with "enc:" but not a valid enc:v1 payload is encrypted', async () => {
    const { planEncryption } = await import("@/lib/secrets-migration");
    const { isEncrypted, decryptSecret } = await import("@/lib/secrets");
    const value = "enc:v2:not-ours";
    expect(isEncrypted(value)).toBe(false);
    const plan = planEncryption([{ id: "1", value }]);
    expect(plan).toHaveLength(1);
    expect(decryptSecret(plan[0]?.to ?? "")).toBe(value);
  });

  it("running the plan on its own output yields no changes", async () => {
    const { planEncryption } = await import("@/lib/secrets-migration");
    const first = planEncryption([
      { id: "1", value: "a" },
      { id: "2", value: null },
    ]);
    expect(first).toHaveLength(1);
    expect(
      planEncryption(first.map((c) => ({ id: c.id, value: c.to })))
    ).toEqual([]);
  });

  it("SECRET_COLUMNS lists exactly the four columns", async () => {
    const { SECRET_COLUMNS } = await import("@/lib/secrets-migration");
    expect(SECRET_COLUMNS).toEqual([
      { table: "servers", column: "password" },
      { table: "environment_services", column: "db_password" },
      { table: "environment_services", column: "mock_time_api_key" },
      { table: "s3_connections", column: "secret_key" },
    ]);
  });
});
