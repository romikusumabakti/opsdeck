import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rows: Record<string, unknown>[] = [];

// Minimal in-memory stand-in for the ssh_keys table that honours the
// "one current row" unique index.
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => rows.slice(0, 1),
        }),
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (rows.some((r) => r.status === "current")) return [];
            const row = {
              id: `key-${rows.length + 1}`,
              status: "current",
              ...v,
            };
            rows.push(row);
            return [row];
          },
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/secrets", () => ({
  encryptSecret: (s: string) => `enc:${s}`,
  decryptSecret: (s: string) => s.replace(/^enc:/, ""),
}));

import {
  authorizedKeysLine,
  ensureCurrentKey,
  fromAddress,
  generateInstanceKey,
  keyMarker,
  loadPrivateKey,
  mergeAuthorizedKeys,
  removeAuthorizedKey,
} from "@/lib/ssh-keys";

const MARKER = "opsdeck:opsdeck:K";
const OURS = authorizedKeysLine("ssh-ed25519 AAAA x", "10.0.0.1", MARKER);

beforeEach(() => {
  rows.length = 0;
});

describe("generateInstanceKey", () => {
  it("generates an ed25519 key", () => {
    const k = generateInstanceKey();
    expect(k.publicKey.startsWith("ssh-ed25519 ")).toBe(true);
    expect(k.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(k.privateKeyPem).toContain("BEGIN OPENSSH PRIVATE KEY");

    let out: string | null = null;
    const dir = mkdtempSync(join(tmpdir(), "ssh-keys-test-"));
    try {
      const pub = join(dir, "k.pub");
      writeFileSync(pub, `${k.publicKey}\n`);
      out = execFileSync("ssh-keygen", ["-lf", pub], { encoding: "utf8" });
    } catch {
      console.warn(
        "ssh-keygen not available; skipping fingerprint cross-check"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    if (out) expect(out.split(/\s+/)[1]).toBe(k.fingerprint);
  });
});

describe("authorized_keys helpers", () => {
  it("line format", () => {
    expect(
      authorizedKeysLine("ssh-ed25519 AAAA x", "192.168.56.113", MARKER)
    ).toBe(
      `from="192.168.56.113",no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA ${MARKER}`
    );
  });

  it("merge keeps foreign lines", () => {
    const existing =
      "# comment\nssh-rsa AAAAB3 alice@x\n\nssh-ed25519 BBBB bob\n";
    expect(mergeAuthorizedKeys(existing, OURS, MARKER)).toBe(
      `${existing}${OURS}\n`
    );
  });

  it("replaces same marker", () => {
    const old = authorizedKeysLine("ssh-ed25519 OLD x", "1.1.1.1", MARKER);
    const existing = `ssh-rsa A a\n${old}\nssh-rsa B b\n`;
    expect(mergeAuthorizedKeys(existing, OURS, MARKER)).toBe(
      `ssh-rsa A a\n${OURS}\nssh-rsa B b\n`
    );
  });

  it("handles CRLF and no newline", () => {
    expect(
      mergeAuthorizedKeys("ssh-rsa A a\r\nssh-rsa B b", OURS, MARKER)
    ).toBe(`ssh-rsa A a\r\nssh-rsa B b\n${OURS}\n`);
    expect(mergeAuthorizedKeys("", OURS, MARKER)).toBe(`${OURS}\n`);
    expect(
      mergeAuthorizedKeys(`ssh-rsa A a\r\n${OURS}\r\n`, OURS, MARKER)
    ).toBe(`ssh-rsa A a\r\n${OURS}\n`);
  });

  it("remove drops only our marker line", () => {
    const existing = `ssh-rsa A a\n${OURS}\nssh-rsa B opsdeck:opsdeck:K2\n`;
    expect(removeAuthorizedKey(existing, MARKER)).toBe(
      "ssh-rsa A a\nssh-rsa B opsdeck:opsdeck:K2\n"
    );
  });
});

describe("fromAddress", () => {
  it("uses the subnet for own-network clients and the address otherwise", () => {
    expect(fromAddress("172.29.0.7 51000 22", "172.29.0.0/16")).toBe(
      "172.29.0.0/16"
    );
    expect(fromAddress("103.75.27.250 5 22", "172.29.0.0/16")).toBe(
      "103.75.27.250"
    );
    expect(fromAddress("103.75.27.250 5 22", null)).toBe("103.75.27.250");
  });
});

describe("keyMarker", () => {
  it("embeds the instance name and key id", () => {
    expect(keyMarker("abc")).toMatch(/^opsdeck:[^:]+:abc$/);
  });
});

describe("ensureCurrentKey", () => {
  it("is idempotent", async () => {
    const a = await ensureCurrentKey();
    const b = await ensureCurrentKey();
    expect(rows).toHaveLength(1);
    expect(b.id).toBe(a.id);
    expect(a.publicKey.startsWith("ssh-ed25519 ")).toBe(true);
    expect(await loadPrivateKey(a.id)).toContain("BEGIN OPENSSH PRIVATE KEY");
  });
});
