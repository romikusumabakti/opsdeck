import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ssh2 from "ssh2";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rows: Record<string, unknown>[] = [];
let racingWinner: Record<string, unknown> | null = null;

vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  eq: (column: { name: string }, value: unknown) => ({
    column: column.name,
    value,
  }),
}));

// Minimal in-memory stand-in for the ssh_keys table: filters by the eq()
// condition and honours the "one current row" unique index.
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (cond: { column: string; value: unknown }) => ({
          limit: async () =>
            rows.filter((r) => r[cond.column] === cond.value).slice(0, 1),
        }),
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (racingWinner) {
              // Another process wins between our select and insert.
              rows.push(racingWinner);
              return [];
            }
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
  racingWinner = null;
  vi.unstubAllEnvs();
});

describe("generateInstanceKey", () => {
  it("skips a generated private key that does not parse", () => {
    const real = ssh2.utils.generateKeyPairSync;
    const good = real("ed25519");
    const spy = vi
      .spyOn(ssh2.utils, "generateKeyPairSync")
      .mockReturnValueOnce({
        public: good.public,
        private:
          "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n",
      })
      .mockReturnValueOnce(good);
    try {
      expect(generateInstanceKey().privateKeyPem).toBe(good.private);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

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
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
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

  it("collapses duplicate marker lines and ignores comments", () => {
    const existing = `# ${MARKER}\n${OURS}\nssh-rsa A a\n${OURS}\n`;
    expect(mergeAuthorizedKeys(existing, OURS, MARKER)).toBe(
      `# ${MARKER}\n${OURS}\nssh-rsa A a\n`
    );
    expect(removeAuthorizedKey(existing, MARKER)).toBe(
      `# ${MARKER}\nssh-rsa A a\n`
    );
  });

  it("remove drops only our marker line", () => {
    const existing = `ssh-rsa A a\n${OURS}\nssh-rsa B opsdeck:opsdeck:K2\n`;
    expect(removeAuthorizedKey(existing, MARKER)).toBe(
      "ssh-rsa A a\nssh-rsa B opsdeck:opsdeck:K2\n"
    );
  });
});

describe("authorizedKeysLine validation", () => {
  const KEY = "ssh-ed25519 AAAA x";
  it("accepts IPs and CIDRs", () => {
    expect(authorizedKeysLine(KEY, "10.0.0.0/8", MARKER)).toContain(
      'from="10.0.0.0/8"'
    );
    expect(authorizedKeysLine(KEY, "::1", MARKER)).toContain('from="::1"');
    expect(authorizedKeysLine(KEY, "fd00::/64", MARKER)).toContain(
      'from="fd00::/64"'
    );
  });

  it.each([
    '1.2.3.4",command="id',
    "1.2.3.4,command=id",
    "1.2.3.4 x",
    "",
    "not-an-ip",
    "10.0.0.0/33",
    "fd00::/129",
    "10.0.0.0/",
    "10.0.0.0/8/8",
    "fe80::1%eth0",
    "fe80::/64%eth0",
  ])("rejects from=%j", (from) => {
    expect(() => authorizedKeysLine(KEY, from, MARKER)).toThrow();
  });

  it("rejects non-ed25519 keys, empty blobs, and bad markers", () => {
    expect(() =>
      authorizedKeysLine("ssh-rsa AAAA x", "1.2.3.4", MARKER)
    ).toThrow();
    expect(() =>
      authorizedKeysLine("ssh-ed25519", "1.2.3.4", MARKER)
    ).toThrow();
    expect(() => authorizedKeysLine(KEY, "1.2.3.4", "opsdeck:a b:K")).toThrow();
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

  it("returns null when SSH_CLIENT does not start with an IP", () => {
    expect(fromAddress("", null)).toBeNull();
    expect(fromAddress("   ", "172.29.0.0/16")).toBeNull();
    expect(fromAddress('1.2.3.4",command="id 1 22', null)).toBeNull();
    expect(
      fromAddress("sudo: unable to resolve host", "172.29.0.0/16")
    ).toBeNull();
  });

  it("falls back to the plain address on an invalid subnet", () => {
    expect(fromAddress("172.29.0.7 1 22", "172.29.0.0/99")).toBe("172.29.0.7");
    expect(fromAddress("172.29.0.7 1 22", "garbage")).toBe("172.29.0.7");
  });
});

describe("keyMarker", () => {
  it("embeds the instance name and key id", () => {
    vi.stubEnv("COMPOSE_PROJECT_NAME", "panel-2");
    expect(keyMarker("abc")).toBe("opsdeck:panel-2:abc");
  });

  it("falls back to opsdeck when the project name is missing or invalid", () => {
    vi.stubEnv("COMPOSE_PROJECT_NAME", "");
    expect(keyMarker("abc")).toBe("opsdeck:opsdeck:abc");
    vi.stubEnv("COMPOSE_PROJECT_NAME", "bad name:x");
    expect(keyMarker("abc")).toBe("opsdeck:opsdeck:abc");
  });
});

describe("ensureCurrentKey", () => {
  it("is idempotent", async () => {
    const a = await ensureCurrentKey();
    const b = await ensureCurrentKey();
    expect(rows).toHaveLength(1);
    expect(b.id).toBe(a.id);
    expect(a.publicKey.startsWith("ssh-ed25519 ")).toBe(true);
  });

  it("returns the winner's row when the insert loses the race", async () => {
    racingWinner = {
      id: "winner",
      status: "current",
      publicKey: "ssh-ed25519 WIN",
      fingerprint: "SHA256:w",
      privateKey: "enc:p",
    };
    const key = await ensureCurrentKey();
    expect(key).toEqual({
      id: "winner",
      publicKey: "ssh-ed25519 WIN",
      fingerprint: "SHA256:w",
    });
    expect(rows).toHaveLength(1);
  });
});

describe("loadPrivateKey", () => {
  it("selects by id and decrypts", async () => {
    rows.push(
      { id: "a", status: "previous", privateKey: "enc:PEM-A" },
      { id: "b", status: "current", privateKey: "enc:PEM-B" }
    );
    expect(await loadPrivateKey("b")).toBe("PEM-B");
    expect(await loadPrivateKey("a")).toBe("PEM-A");
    await expect(loadPrivateKey("zzz")).rejects.toThrow();
  });
});
