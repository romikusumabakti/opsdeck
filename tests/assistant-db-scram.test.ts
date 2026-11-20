import { describe, expect, it } from "vitest";
import { scramSha256Verifier } from "@/lib/assistant-db/scram";

describe("scramSha256Verifier", () => {
  it("matches an independently computed verifier", async () => {
    // Expected value computed with:
    // python3 -c "import hashlib,hmac,base64; s=base64.b64decode('W22ZaJ0SNY7soEsUEjb6gQ=='); sp=hashlib.pbkdf2_hmac('sha256',b'pencil',s,4096,32); ck=hmac.new(sp,b'Client Key','sha256').digest(); sk=hmac.new(sp,b'Server Key','sha256').digest(); print('SCRAM-SHA-256\$4096:W22ZaJ0SNY7soEsUEjb6gQ==\$'+base64.b64encode(hashlib.sha256(ck).digest()).decode()+':'+base64.b64encode(sk).decode())"
    const salt = Uint8Array.from(atob("W22ZaJ0SNY7soEsUEjb6gQ=="), (c) =>
      c.charCodeAt(0)
    );
    await expect(
      scramSha256Verifier("pencil", { salt, iterations: 4096 })
    ).resolves.toBe(
      "SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU="
    );
  });

  it("defaults to 4096 iterations and a fresh 16-byte salt", async () => {
    const pattern =
      /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/;
    const a = await scramSha256Verifier("pencil");
    const b = await scramSha256Verifier("pencil");
    expect(a).toMatch(pattern);
    expect(b).toMatch(pattern);
    expect(a).not.toBe(b);
  });

  it("refuses a password outside [A-Za-z0-9]", async () => {
    await expect(scramSha256Verifier("a b")).rejects.toThrow();
    await expect(scramSha256Verifier("é")).rejects.toThrow();
  });
});
