import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ssh2 from "ssh2";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { parseableKeyPair } from "@/lib/ssh-keypair";

// The connection factory against a real in-process sshd (ssh2's Server) with a
// fixed host key, and an in-memory servers table that honours the conditional
// pin update (`WHERE id = ? AND host_key IS NULL AND host = ?`).

type Row = Record<string, unknown>;
type Cond =
  | { op: "eq"; key: string; value: unknown }
  | { op: "ne"; key: string; value: unknown }
  | { op: "isNull"; key: string }
  | { op: "and" | "or"; conds: Cond[] };

const state = vi.hoisted(() => ({
  servers: [] as Record<string, unknown>[],
  activity: [] as Record<string, unknown>[],
  clientPrivateKey: "",
  loadedKeyIds: [] as string[],
  // When > 0, pin attempts wait until this many have arrived, so concurrent
  // first connections both see "no pin" before either writes.
  pinBarrier: 0,
  pinArrived: 0,
  pinWaiters: [] as (() => void)[],
  // Runs just before an update applies, to interleave a concurrent write.
  beforeUpdate: null as ((values: Record<string, unknown>) => void) | null,
}));

// "host_key" -> "hostKey": the fake rows are keyed like drizzle's JS fields.
const camel = (name: string) =>
  name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  eq: (column: { name: string }, value: unknown) => ({
    op: "eq",
    key: camel(column.name),
    value,
  }),
  ne: (column: { name: string }, value: unknown) => ({
    op: "ne",
    key: camel(column.name),
    value,
  }),
  isNull: (column: { name: string }) => ({
    op: "isNull",
    key: camel(column.name),
  }),
  and: (...conds: unknown[]) => ({ op: "and", conds }),
  or: (...conds: unknown[]) => ({ op: "or", conds }),
}));

vi.mock("@/lib/db", () => {
  const matches = (row: Row, cond: Cond): boolean => {
    if (cond.op === "eq") return row[cond.key] === cond.value;
    // SQL semantics: a comparison with NULL is never true.
    if (cond.op === "ne") {
      return row[cond.key] != null && row[cond.key] !== cond.value;
    }
    if (cond.op === "isNull") return row[cond.key] == null;
    if (cond.op === "or") return cond.conds.some((c) => matches(row, c));
    return cond.conds.every((c) => matches(row, c));
  };
  const barrier = async () => {
    state.pinArrived++;
    if (state.pinArrived >= state.pinBarrier) {
      for (const release of state.pinWaiters.splice(0)) release();
      return;
    }
    await new Promise<void>((resolve) => state.pinWaiters.push(resolve));
  };
  const query = (run: () => Promise<Row[]>) => ({
    limit: run,
    for: run,
    returning: run,
    // biome-ignore lint/suspicious/noThenProperty: awaitable like a drizzle query
    then: (ok: (rows: Row[]) => unknown, fail: (e: unknown) => unknown) =>
      run().then(ok, fail),
  });
  const db = {
    select: () => ({
      from: () => ({
        where: (cond: Cond) =>
          query(async () =>
            state.servers.filter((r) => matches(r, cond)).map((r) => ({ ...r }))
          ),
      }),
    }),
    update: () => ({
      set: (values: Row) => ({
        where: (cond: Cond) =>
          query(async () => {
            const isPin = typeof values.hostKey === "string";
            if (isPin && state.pinBarrier > 0) await barrier();
            state.beforeUpdate?.(values);
            const hit = state.servers.filter((r) => matches(r, cond));
            for (const r of hit) Object.assign(r, values);
            return hit.map((r) => ({ ...r }));
          }),
      }),
    }),
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  return { db };
});

vi.mock("@/lib/activity", () => ({
  recordActivity: async (input: Record<string, unknown>) => {
    state.activity.push(input);
  },
}));

vi.mock("@/lib/ssh-keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ssh-keys")>()),
  loadPrivateKey: async (id: string) => {
    state.loadedKeyIds.push(id);
    return state.clientPrivateKey;
  },
  ensureCurrentKey: async () => ({
    id: "key-current",
    publicKey: "",
    fingerprint: "",
  }),
}));

vi.mock("@/lib/authz", () => ({
  requireOrgPermission: async () => ({ user: { id: "user-1" } }),
}));

vi.mock("@/server/i18n", () => ({
  getServerTranslator: async () => (key: string) => key,
}));

vi.mock("@/lib/ssh-connect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ssh-connect")>();
  return { ...actual, connectConfig: vi.fn(actual.connectConfig) };
});

const { connectConfig, trustOfferedHostKey } = await import(
  "@/lib/ssh-connect"
);
const { executeRemoteCommand, testSshConnection } = await import("@/lib/ssh");
const { sshFingerprint } = await import("@/lib/ssh-keys");
const { testServerConnection, updateServer } = await import(
  "@/server/services/servers"
);
const { leaseSftp, openSftp, __resetSftpPool } = await import(
  "@/lib/explorer/sftp-pool"
);
const { openSshShell } = await import("@/lib/terminal/ssh-shell");

const keyA = parseableKeyPair();
const keyB = parseableKeyPair();
const clientKey = parseableKeyPair();
const blobOf = (publicKey: string) =>
  Buffer.from(publicKey.split(" ")[1] ?? "", "base64");
const blobA = blobOf(keyA.public);
const blobB = blobOf(keyB.public);
const clientBlob = blobOf(clientKey.public);

type Sshd = {
  port: number;
  authMethods: string[];
  server: ssh2.Server;
};

function startSshd(hostKey: string): Promise<Sshd> {
  const sshd: Sshd = {
    port: 0,
    authMethods: [],
    server: new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
      client.on("error", () => {});
      client.on("authentication", (ctx) => {
        sshd.authMethods.push(ctx.method);
        if (ctx.method === "password" && ctx.password === "pw") {
          ctx.accept();
          return;
        }
        if (ctx.method === "publickey" && ctx.key.data.equals(clientBlob)) {
          ctx.accept();
          return;
        }
        ctx.reject(["password", "publickey"]);
      });
      client.on("ready", () => {
        client.on("session", (accept) => {
          const session = accept();
          session.on("exec", (acceptExec) => {
            const stream = acceptExec();
            stream.exit(0);
            stream.end();
          });
          session.on("sftp", (acceptSftp) => {
            acceptSftp();
          });
          session.on("pty", (a) => a?.());
          session.on("shell", (acceptShell) => {
            acceptShell();
          });
        });
      });
    }),
  };
  return new Promise((resolve) => {
    sshd.server.listen(0, "127.0.0.1", () => {
      sshd.port = (sshd.server.address() as { port: number }).port;
      resolve(sshd);
    });
  });
}

let sshdA: Sshd;
let sshdB: Sshd;

beforeAll(async () => {
  state.clientPrivateKey = clientKey.private;
  sshdA = await startSshd(keyA.private);
  sshdB = await startSshd(keyB.private);
});

afterAll(() => {
  sshdA.server.close();
  sshdB.server.close();
});

const SERVER_ID = "0197f3a0-1b2c-7def-8000-0123456789aa";

function serverRow(overrides: Row = {}): Row {
  return {
    id: SERVER_ID,
    name: "web-1",
    host: "127.0.0.1",
    username: "root",
    auth: "password",
    password: "pw",
    hostKeyType: null,
    hostKey: null,
    hostKeyFingerprint: null,
    hostKeyPinnedAt: null,
    hostKeyOfferedType: null,
    hostKeyOffered: null,
    hostKeyOfferedFingerprint: null,
    sshKeyId: null,
    ...overrides,
  };
}

const pinnedTo = (blob: Buffer) => ({
  hostKeyType: "ssh-ed25519",
  hostKey: blob.toString("base64"),
  hostKeyFingerprint: sshFingerprint(blob),
  hostKeyPinnedAt: new Date("2026-01-01T00:00:00Z"),
});

function target(sshd: Sshd, overrides: Record<string, unknown> = {}) {
  return {
    serverId: SERVER_ID as string | null,
    host: "127.0.0.1",
    port: sshd.port,
    username: "root",
    password: "pw" as string | null,
    auth: "password" as "password" | "key",
    ...overrides,
  };
}

const row = () => state.servers[0] as Row;

beforeEach(() => {
  state.servers = [serverRow()];
  state.activity = [];
  state.pinBarrier = 0;
  state.pinArrived = 0;
  state.pinWaiters = [];
  state.beforeUpdate = null;
  state.loadedKeyIds = [];
  sshdA.authMethods.length = 0;
  sshdB.authMethods.length = 0;
  vi.mocked(connectConfig).mockClear();
});

afterEach(() => {
  __resetSftpPool();
});

describe("host key pinning", () => {
  it("pins on first connection", async () => {
    await executeRemoteCommand(target(sshdA), "true");

    expect(row().hostKey).toBe(blobA.toString("base64"));
    expect(row().hostKeyType).toBe("ssh-ed25519");
    expect(row().hostKeyFingerprint).toBe(sshFingerprint(blobA));
    expect(row().hostKeyFingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(row().hostKeyPinnedAt).toBeInstanceOf(Date);
    expect(state.activity).toEqual([
      expect.objectContaining({
        actorId: null,
        action: "server.hostKeyPinned",
        entityType: "server",
        entityId: SERVER_ID,
        data: { server: "web-1", fingerprint: sshFingerprint(blobA) },
      }),
    ]);
  });

  it("records the given actor on a pin", async () => {
    await testSshConnection(target(sshdA), { actor: "user-7" });
    expect(state.activity).toEqual([
      expect.objectContaining({
        actorId: "user-7",
        action: "server.hostKeyPinned",
      }),
    ]);
  });

  it("a background run's pin and mismatch are recorded for system and the run", async () => {
    await executeRemoteCommand(target(sshdA, { run: "run-9" }), "true");
    await expect(
      executeRemoteCommand(target(sshdB, { run: "run-10" }), "true")
    ).rejects.toMatchObject({ code: "hostKeyMismatch" });
    expect(state.activity).toEqual([
      expect.objectContaining({
        actorId: null,
        action: "server.hostKeyPinned",
        data: {
          server: "web-1",
          fingerprint: sshFingerprint(blobA),
          run: "run-9",
        },
      }),
      expect.objectContaining({
        actorId: null,
        action: "server.hostKeyMismatch",
        data: expect.objectContaining({ run: "run-10" }),
      }),
    ]);
  });

  it("accepts pinned key", async () => {
    state.servers = [serverRow(pinnedTo(blobA))];

    await executeRemoteCommand(target(sshdA), "true");

    expect(row().hostKeyPinnedAt).toEqual(new Date("2026-01-01T00:00:00Z"));
    expect(row().hostKeyOfferedFingerprint).toBeNull();
    expect(state.activity).toEqual([]);
  });

  it("refuses mismatch before auth", async () => {
    state.servers = [serverRow(pinnedTo(blobA))];

    await expect(
      executeRemoteCommand(target(sshdB), "true")
    ).rejects.toMatchObject({ code: "hostKeyMismatch" });

    expect(sshdB.authMethods).toEqual([]);
    expect(row()).toMatchObject({
      hostKey: blobA.toString("base64"),
      hostKeyOfferedType: "ssh-ed25519",
      hostKeyOffered: blobB.toString("base64"),
      hostKeyOfferedFingerprint: sshFingerprint(blobB),
    });
    expect(state.activity).toEqual([
      expect.objectContaining({
        actorId: null,
        action: "server.hostKeyMismatch",
        entityId: SERVER_ID,
        data: {
          server: "web-1",
          fingerprint: sshFingerprint(blobB),
          pinned: sshFingerprint(blobA),
        },
      }),
    ]);
  });

  it("records a mismatch once per newly offered key", async () => {
    state.servers = [serverRow(pinnedTo(blobA))];
    for (let i = 0; i < 2; i++) {
      await expect(
        executeRemoteCommand(target(sshdB), "true")
      ).rejects.toMatchObject({ code: "hostKeyMismatch" });
    }
    expect(
      state.activity.filter((a) => a.action === "server.hostKeyMismatch")
    ).toHaveLength(1);
  });

  it("does not record an offered key for an address the row no longer has", async () => {
    state.servers = [serverRow(pinnedTo(blobA))];
    // An admin edits the host between the pin read and the offered write.
    state.beforeUpdate = (values) => {
      if (typeof values.hostKeyOffered === "string") row().host = "10.9.9.9";
    };

    await expect(
      executeRemoteCommand(target(sshdB), "true")
    ).rejects.toMatchObject({ code: "hostKeyMismatch" });

    expect(row().hostKeyOfferedFingerprint).toBeNull();
    expect(state.activity).toEqual([]);
  });

  it("reports a mismatch from the connection test as a code", async () => {
    state.servers = [serverRow(pinnedTo(blobA))];
    const result = await testSshConnection(target(sshdB));
    expect(result).toMatchObject({ ok: false, code: "hostKeyMismatch" });
  });

  it("concurrent first connections pin once", async () => {
    state.pinBarrier = 2;

    await Promise.all([
      executeRemoteCommand(target(sshdA), "true"),
      executeRemoteCommand(target(sshdA), "true"),
    ]);

    expect(state.pinArrived).toBe(2);
    expect(row().hostKey).toBe(blobA.toString("base64"));
    expect(
      state.activity.filter((a) => a.action === "server.hostKeyPinned")
    ).toHaveLength(1);
  });

  it("does not pin a key observed for an address the row no longer has", async () => {
    state.servers = [serverRow({ host: "10.9.9.9" })];

    await expect(executeRemoteCommand(target(sshdA), "true")).rejects.toThrow();

    expect(row().hostKey).toBeNull();
    expect(sshdA.authMethods).toEqual([]);
  });

  it("accepts an unsaved target and returns the observed key", async () => {
    const observed: unknown[] = [];
    const result = await testSshConnection(target(sshdA, { serverId: null }), {
      onHostKey: (key) => observed.push(key),
    });

    expect(result).toEqual({ ok: true });
    expect(observed).toEqual([
      {
        type: "ssh-ed25519",
        key: blobA.toString("base64"),
        fingerprint: sshFingerprint(blobA),
      },
    ]);
    expect(row().hostKey).toBeNull();
    expect(state.activity).toEqual([]);
  });

  it("restricts host key algorithms to the pinned type", async () => {
    state.servers = [serverRow(pinnedTo(blobA))];
    const config = await connectConfig(target(sshdA));
    expect(config.algorithms?.serverHostKey).toEqual(["ssh-ed25519"]);
    expect(typeof config.hostVerifier).toBe("function");
  });
});

describe("credentials", () => {
  it("uses key when auth=key", async () => {
    state.servers = [serverRow({ auth: "key", sshKeyId: "key-1" })];

    await executeRemoteCommand(target(sshdA, { auth: "key" }), "true");

    expect(sshdA.authMethods).toContain("publickey");
    expect(sshdA.authMethods).not.toContain("password");
  });

  it("keyOnly offers no password even for a password server", async () => {
    const config = await connectConfig(target(sshdA), { keyOnly: true });
    expect(config.password).toBeUndefined();
    expect(config.privateKey).toBe(clientKey.private);
  });

  it("keyId picks the key over the one the server has", async () => {
    state.servers = [serverRow({ auth: "key", sshKeyId: "key-1" })];
    await connectConfig(target(sshdA, { auth: "key" }), {
      keyOnly: true,
      keyId: "key-2",
    });
    expect(state.loadedKeyIds).toEqual(["key-2"]);
  });

  it("passwordOnce is used instead of the key or the stored password", async () => {
    state.servers = [serverRow({ auth: "key", sshKeyId: "key-1" })];
    const config = await connectConfig(
      target(sshdA, { auth: "key", password: null }),
      { passwordOnce: "once" }
    );
    expect(config.password).toBe("once");
    expect(config.privateKey).toBeUndefined();
  });
});

describe("server edits and trust", () => {
  it("host change clears pin", async () => {
    state.servers = [
      serverRow({
        ...pinnedTo(blobA),
        auth: "key",
        hostKeyOfferedFingerprint: "SHA256:x",
      }),
    ];

    const result = await updateServer(SERVER_ID, { host: "10.0.0.9" });

    expect(result.success).toBe(true);
    expect(row()).toMatchObject({
      host: "10.0.0.9",
      auth: "key",
      hostKeyType: null,
      hostKey: null,
      hostKeyFingerprint: null,
      hostKeyPinnedAt: null,
      hostKeyOfferedFingerprint: null,
    });
  });

  it("an edit that keeps the host keeps the pin", async () => {
    state.servers = [serverRow(pinnedTo(blobA))];

    await updateServer(SERVER_ID, { host: "127.0.0.1", name: "web-2" });

    expect(row().hostKey).toBe(blobA.toString("base64"));
    expect(row().name).toBe("web-2");
  });

  async function mismatchWith(sshd: Sshd) {
    await expect(
      executeRemoteCommand(target(sshd), "true")
    ).rejects.toMatchObject({ code: "hostKeyMismatch" });
  }

  it("trust pins exactly the offered key", async () => {
    state.servers = [serverRow(pinnedTo(blobA))];
    await mismatchWith(sshdB);
    state.activity = [];

    const result = await trustOfferedHostKey(
      SERVER_ID,
      "user-1",
      sshFingerprint(blobB)
    );

    expect(result).toEqual({ ok: true });
    expect(row()).toMatchObject({
      hostKeyType: "ssh-ed25519",
      hostKey: blobB.toString("base64"),
      hostKeyFingerprint: sshFingerprint(blobB),
      hostKeyOfferedType: null,
      hostKeyOffered: null,
      hostKeyOfferedFingerprint: null,
    });
    expect(row().hostKeyPinnedAt).not.toEqual(new Date("2026-01-01T00:00:00Z"));
    expect(state.activity).toEqual([
      expect.objectContaining({
        actorId: "user-1",
        action: "server.hostKeyTrusted",
        entityId: SERVER_ID,
        data: { server: "web-1", fingerprint: sshFingerprint(blobB) },
      }),
    ]);

    // The trusted key connects; any other key is refused again.
    await executeRemoteCommand(target(sshdB), "true");
    await mismatchWith(sshdA);
    expect(row().hostKey).toBe(blobB.toString("base64"));
    expect(row().hostKeyOfferedFingerprint).toBe(sshFingerprint(blobA));
  });

  it("trust with a stale expected fingerprint is refused", async () => {
    state.servers = [serverRow(pinnedTo(blobA))];
    await mismatchWith(sshdB);
    state.activity = [];
    const before = { ...row() };

    const result = await trustOfferedHostKey(
      SERVER_ID,
      "user-1",
      sshFingerprint(clientBlob)
    );

    expect(result).toEqual({ ok: false, code: "hostKeyChanged" });
    expect(row()).toEqual(before);
    expect(state.activity).toEqual([]);
  });

  it("trust without an offered key is refused", async () => {
    state.servers = [serverRow(pinnedTo(blobA))];
    const result = await trustOfferedHostKey(
      SERVER_ID,
      "user-1",
      sshFingerprint(blobB)
    );
    expect(result).toEqual({ ok: false, code: "hostKeyChanged" });
    expect(row().hostKey).toBe(blobA.toString("base64"));
  });

  it("test connection never sends the stored password to an edited host", async () => {
    state.servers = [serverRow({ host: "10.9.9.9" })];

    const result = await testServerConnection({
      host: "127.0.0.1",
      username: "root",
      serverId: SERVER_ID,
    });

    expect(result).toEqual({
      ok: false,
      code: "passwordRequired",
      message: "passwordRequired",
    });
    expect(connectConfig).not.toHaveBeenCalled();
  });
});

describe("every client goes through connectConfig", () => {
  it("SFTP pool: one call per dial, none for a reused connection", async () => {
    const lease1 = await leaseSftp(target(sshdA));
    lease1.release();
    const lease2 = await leaseSftp(target(sshdA));
    lease2.release();
    expect(connectConfig).toHaveBeenCalledTimes(1);

    const conn = await openSftp(target(sshdA));
    conn.dispose();
    expect(connectConfig).toHaveBeenCalledTimes(2);
  });

  it("SFTP pool refuses a mismatched host", async () => {
    state.servers = [serverRow(pinnedTo(blobA))];
    await expect(leaseSftp(target(sshdB))).rejects.toMatchObject({
      code: "hostKeyMismatch",
    });
  });

  it("terminal: one call per shell", async () => {
    const shell = await openSshShell(target(sshdA), { cols: 80, rows: 24 });
    shell.close();
    expect(connectConfig).toHaveBeenCalledTimes(1);
    expect(row().hostKey).toBe(blobA.toString("base64"));
  });

  it("terminal records its user on a first-use pin", async () => {
    const shell = await openSshShell(target(sshdA), {
      cols: 80,
      rows: 24,
      actor: "user-9",
    });
    shell.close();
    expect(state.activity).toEqual([
      expect.objectContaining({
        actorId: "user-9",
        action: "server.hostKeyPinned",
      }),
    ]);
  });

  it("explorer records its user on a first-use pin", async () => {
    const lease = await leaseSftp(target(sshdA), { actor: "user-8" });
    lease.release();
    expect(state.activity).toEqual([
      expect.objectContaining({
        actorId: "user-8",
        action: "server.hostKeyPinned",
      }),
    ]);
  });

  it("terminal refuses a mismatched host", async () => {
    state.servers = [serverRow(pinnedTo(blobA))];
    await expect(
      openSshShell(target(sshdB), { cols: 80, rows: 24 })
    ).rejects.toMatchObject({ code: "hostKeyMismatch" });
    expect(sshdB.authMethods).toEqual([]);
  });
});

// Source guard: an SSH client may only be created in the two modules that
// connect it with connectConfig, so no new path can skip host verification.
describe("no SSH connection bypasses the factory", () => {
  const root = join(import.meta.dirname, "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx|js|mjs)$/.test(name)) files.push(path);
    }
  };
  for (const dir of ["lib", "server", "scripts", "web", "components"]) {
    walk(join(root, dir));
  }

  const ALLOWED = [
    "lib/ssh.ts",
    "lib/ssh-session.ts",
    "lib/terminal/ssh-shell.ts",
  ];

  it("only lib/ssh.ts and lib/terminal/ssh-shell.ts create SSH clients", () => {
    const offenders = files
      .map((path) => ({
        file: relative(root, path),
        source: readFileSync(path, "utf8"),
      }))
      .filter(
        ({ source }) =>
          // node-ssh in any value form: import, require, dynamic import.
          /^import (?!type )[^;]*from "node-ssh"/m.test(source) ||
          /(require|import)\(\s*["']node-ssh["']\s*\)/.test(source) ||
          // ssh2's Client: named, default/namespace (`ssh2.Client`), require.
          /^import \{[^}]*\bClient\b[^}]*\} from "ssh2"/m.test(source) ||
          /^import (?!type )(\* as )?\w+[^;]*from "ssh2"/m.test(source) ||
          /(require|import)\(\s*["']ssh2["']\s*\)/.test(source) ||
          /new\s+(NodeSSH|Client)\s*\(/.test(source) ||
          /\.Client\s*\(/.test(source) ||
          // The OpenSSH binaries, through child_process or Bun.spawn.
          /\b(spawn|spawnSync|exec|execSync|execFile|execFileSync)\(\s*["'`](ssh|sftp|scp)\b/.test(
            source
          ) ||
          /Bun\.spawn(Sync)?\(\s*\[\s*["'`](ssh|sftp|scp)\b/.test(source)
      )
      .map(({ file }) => file)
      .filter((file) => !ALLOWED.includes(file));
    expect(offenders).toEqual([]);
  });

  it("every connect() in those modules takes a connectConfig result", () => {
    for (const file of ALLOWED) {
      const source = readFileSync(join(root, file), "utf8");
      const connects = [...source.matchAll(/\.connect\(\s*([^)]*)/g)].map(
        (m) => m[1] ?? ""
      );
      expect(connects.length, file).toBeGreaterThan(0);
      for (const arg of connects) {
        // `connect(config)` or `connect({ ...config, ...extra })`, where
        // `config` is assigned from `await connectConfig(` in the same file.
        const name = /^(?:\{\s*\.\.\.)?(\w+)/.exec(arg.trim())?.[1] ?? "";
        expect(
          new RegExp(`\\b${name}\\s*=\\s*await connectConfig\\(`).test(source),
          `${file}: connect(${arg.trim()})`
        ).toBe(true);
      }
    }
  });
});
