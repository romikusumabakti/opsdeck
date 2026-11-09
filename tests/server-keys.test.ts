import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// Move, reinstall and trust against a real in-process sshd (ssh2's Server)
// whose exec handler runs each command with /bin/sh in a temp home: the
// install script really reads, merges and replaces a real authorized_keys,
// and key login is accepted only for a key that file holds. The servers table
// is in memory and honours the conditional updates (eq / isNull / and / or).

type Row = Record<string, unknown>;
type Cond =
  | { op: "eq"; key: string; value: unknown }
  | { op: "ne"; key: string; value: unknown }
  | { op: "isNull"; key: string }
  | { op: "and" | "or"; conds: Cond[] };

const KEY_ID = "0197f3a0-1b2c-7def-8000-00000000c0de";
const USER_ID = "0197f3a0-1b2c-7def-8000-0123456789b1";

const state = vi.hoisted(() => ({
  servers: [] as Record<string, unknown>[],
  activity: [] as Record<string, unknown>[],
  clientPublicKey: "",
  clientPrivateKey: "",
  port: 0,
  orgRole: "admin",
  // Advisory locks held, keyed by their two int4 halves.
  locks: new Set<string>(),
  activityFails: false,
}));

const camel = (name: string) =>
  name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

// Only the servers-table conditions are faked; anything else the app builds
// at import time (relations, other tables) keeps drizzle's own operators.
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  const isColumn = (c: unknown): c is { name: string } =>
    typeof (c as { name?: unknown } | null)?.name === "string";
  return {
    ...actual,
    eq: (column: unknown, value: unknown) =>
      isColumn(column)
        ? { op: "eq", key: camel(column.name), value }
        : actual.eq(column as never, value),
    ne: (column: unknown, value: unknown) =>
      isColumn(column)
        ? { op: "ne", key: camel(column.name), value }
        : actual.ne(column as never, value),
    isNull: (column: unknown) =>
      isColumn(column)
        ? { op: "isNull", key: camel(column.name) }
        : actual.isNull(column as never),
    and: (...conds: unknown[]) => ({ op: "and", conds }),
    or: (...conds: unknown[]) => ({ op: "or", conds }),
  };
});

vi.mock("@/lib/db", () => {
  const matches = (row: Row, cond: Cond): boolean => {
    if (cond.op === "eq") return row[cond.key] === cond.value;
    if (cond.op === "ne") {
      return row[cond.key] != null && row[cond.key] !== cond.value;
    }
    if (cond.op === "isNull") return row[cond.key] == null;
    if (cond.op === "or") return cond.conds.some((c) => matches(row, c));
    return cond.conds.every((c) => matches(row, c));
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
    // The key a move installs is current here (ensureCurrentKey is faked).
    select: () => ({
      from: (table: { [k: symbol]: unknown }) =>
        String(table[Symbol.for("drizzle:Name")] ?? "") === "ssh_keys"
          ? {
              where: () =>
                query(async () => [{ id: KEY_ID, status: "current" }]),
            }
          : {
              where: (cond: Cond) =>
                query(async () =>
                  state.servers
                    .filter((r) => matches(r, cond))
                    .map((r) => ({ ...r }))
                ),
            },
    }),
    update: () => ({
      set: (values: Row) => ({
        where: (cond: Cond) =>
          query(async () => {
            const hit = state.servers.filter((r) => matches(r, cond));
            for (const r of hit) Object.assign(r, values);
            return hit.map((r) => ({ ...r }));
          }),
      }),
    }),
  };
  Object.assign(db, {
    transaction: async <T>(fn: (tx: typeof db) => Promise<T>) => fn(db),
  });
  // A reserved connection that understands the two advisory lock queries.
  const pgClient = () => ({
    reserve: async () => {
      const conn = async (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => {
        const text = strings.join("?");
        const key = values.join(":");
        if (text.includes("pg_try_advisory_lock")) {
          if (state.locks.has(key)) return [{ locked: false }];
          state.locks.add(key);
          return [{ locked: true }];
        }
        if (text.includes("pg_advisory_unlock")) state.locks.delete(key);
        return [];
      };
      return Object.assign(conn, { release: () => {} });
    },
  });
  return { db, pgClient };
});

vi.mock("@/lib/activity", () => ({
  recordActivity: async (input: Record<string, unknown>) => {
    if (state.activityFails) throw new Error("activity insert failed");
    state.activity.push(input);
  },
}));

vi.mock("@/lib/ssh-keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ssh-keys")>()),
  loadPrivateKey: async () => state.clientPrivateKey,
  ensureCurrentKey: async () => ({
    id: KEY_ID,
    publicKey: state.clientPublicKey,
    fingerprint: "SHA256:client",
  }),
}));

// Real servers listen on 22; here every target points at the in-process sshd.
vi.mock("@/lib/ssh-connect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ssh-connect")>();
  return {
    ...actual,
    sshTarget: (row: Parameters<typeof actual.sshTarget>[0]) => ({
      ...actual.sshTarget(row),
      port: state.port,
    }),
  };
});

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));
vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({
    user: { id: USER_ID, role: state.orgRole },
  })),
}));
vi.mock("@/lib/authz", async () => {
  const { canOrg } = await import("@/lib/permissions");
  const { HTTPException } = await import("hono/http-exception");
  return {
    requireOrgPermission: vi.fn(async (perms: Parameters<typeof canOrg>[1]) => {
      if (!canOrg(state.orgRole, perms)) {
        throw new HTTPException(403, { message: "Forbidden" });
      }
      return { user: { id: USER_ID, role: state.orgRole } };
    }),
  };
});
vi.mock("@/server/i18n", () => ({
  getServerTranslator: async () => (key: string) => key,
}));

const { moveServerToKey, normaliseSubnet, ownSubnet } = await import(
  "@/server/services/server-keys"
);
const { serverKeyLock, sshFingerprint } = await import("@/lib/ssh-keys");
const { app } = await import("@/server/app");

const hostKey = ssh2.utils.generateKeyPairSync("ed25519");
const otherHostKey = ssh2.utils.generateKeyPairSync("ed25519");
const clientKey = ssh2.utils.generateKeyPairSync("ed25519");
const blobOf = (publicKey: string) =>
  Buffer.from(publicKey.split(" ")[1] ?? "", "base64");
const hostBlob = blobOf(hostKey.public);
const otherHostBlob = blobOf(otherHostKey.public);
const clientBase64 = clientKey.public.split(" ")[1] ?? "";

const SERVER_ID = "0197f3a0-1b2c-7def-8000-0123456789aa";
const MARKER = `opsdeck:opsdeck:${KEY_ID}`;
const FOREIGN =
  "# estate keys\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRomi romi@bluefin-romi\r\nssh-rsa AAAAB3Anggi anggi@bluefin-anggi";

type Sshd = {
  server: ssh2.Server;
  port: number;
  home: string;
  bin: string;
  sshClient: string;
  rejectKey: boolean;
  passwords: Set<string>;
  authMethods: string[];
  // Runs on every publickey attempt, to interleave a concurrent change.
  onKeyAuth: (() => void) | null;
};

let sshd: Sshd;
let root: string;

function authorizedKeys() {
  return join(sshd.home, ".ssh", "authorized_keys");
}

// Key login like sshd: the offered key must be a line of authorized_keys.
function keyAuthorized(key: Buffer): boolean {
  const file = authorizedKeys();
  if (!existsSync(file) || lstatSync(join(sshd.home, ".ssh")).isSymbolicLink())
    return false;
  return readFileSync(file, "utf8")
    .split("\n")
    .some((line) => line.includes(` ${key.toString("base64")} `));
}

function startSshd(privateHostKey: string): Promise<ssh2.Server> {
  const server = new ssh2.Server({ hostKeys: [privateHostKey] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      sshd.authMethods.push(ctx.method);
      if (ctx.method === "publickey") sshd.onKeyAuth?.();
      if (ctx.method === "password" && sshd.passwords.has(ctx.password)) {
        ctx.accept();
        return;
      }
      if (
        ctx.method === "publickey" &&
        !sshd.rejectKey &&
        keyAuthorized(ctx.key.data)
      ) {
        ctx.accept();
        return;
      }
      ctx.reject(["password", "publickey"]);
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          const child = spawn("/bin/sh", ["-c", info.command], {
            env: {
              HOME: sshd.home,
              SSH_CLIENT: sshd.sshClient,
              PATH: `${sshd.bin}:/usr/bin:/bin`,
            },
          });
          stream.pipe(child.stdin);
          child.stdout.pipe(stream, { end: false });
          child.stderr.pipe(stream.stderr, { end: false });
          child.on("close", (code) => {
            stream.exit(code ?? 1);
            stream.end();
          });
        });
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

beforeAll(async () => {
  state.clientPublicKey = clientKey.public;
  state.clientPrivateKey = clientKey.private;
  root = mkdtempSync(join(tmpdir(), "opsdeck-server-keys-"));
  sshd = {
    server: await startSshd(hostKey.private),
    port: 0,
    home: "",
    bin: join(root, "bin"),
    sshClient: "",
    rejectKey: false,
    passwords: new Set(),
    authMethods: [],
    onKeyAuth: null,
  };
  sshd.port = (sshd.server.address() as { port: number }).port;
  mkdirSync(sshd.bin);
});

afterAll(() => {
  sshd.server.close();
  rmSync(root, { recursive: true, force: true });
});

function fakeSudo(ok: boolean) {
  const file = join(sshd.bin, "sudo");
  writeFileSync(
    file,
    ok
      ? '#!/bin/sh\n[ "$1" = "-n" ] && shift\nexec "$@"\n'
      : "#!/bin/sh\necho 'sudo: a password is required' >&2\nexit 1\n"
  );
  chmodSync(file, 0o755);
}

function serverRow(overrides: Row = {}): Row {
  return {
    id: SERVER_ID,
    name: "web-1",
    host: "127.0.0.1",
    username: "root",
    auth: "password",
    password: "pw",
    hostKeyType: "ssh-ed25519",
    hostKey: hostBlob.toString("base64"),
    hostKeyFingerprint: sshFingerprint(hostBlob),
    hostKeyPinnedAt: new Date("2026-01-01T00:00:00Z"),
    hostKeyOfferedType: null,
    hostKeyOffered: null,
    hostKeyOfferedFingerprint: null,
    sshKeyId: null,
    sshFrom: null,
    keyError: null,
    ...overrides,
  };
}

const row = () => state.servers[0] as Row;
const ourLine = (from: string) =>
  `from="${from}",no-agent-forwarding,no-X11-forwarding ssh-ed25519 ${clientBase64} ${MARKER}`;

let homeCount = 0;
beforeEach(() => {
  state.servers = [serverRow()];
  state.activity = [];
  state.orgRole = "admin";
  state.port = sshd.port;
  homeCount += 1;
  sshd.home = join(root, `home-${homeCount}`);
  mkdirSync(sshd.home);
  sshd.sshClient = "127.0.0.1 51000 22";
  sshd.rejectKey = false;
  sshd.passwords = new Set(["pw"]);
  sshd.authMethods = [];
  sshd.onKeyAuth = null;
  state.locks = new Set();
  state.activityFails = false;
  fakeSudo(false);
  delete process.env.OPSDECK_NETWORK_SUBNET;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function seedAuthorizedKeys(content: string) {
  mkdirSync(join(sshd.home, ".ssh"), { mode: 0o700 });
  writeFileSync(authorizedKeys(), content, { mode: 0o644 });
}

describe("moveServerToKey", () => {
  it("moves a root server", async () => {
    seedAuthorizedKeys(FOREIGN);

    expect(await moveServerToKey(SERVER_ID, USER_ID)).toEqual({ ok: true });

    expect(readFileSync(authorizedKeys(), "utf8")).toBe(
      `${FOREIGN}\n${ourLine("127.0.0.1")}\n`
    );
    expect(statSync(authorizedKeys()).mode & 0o777).toBe(0o600);
    expect(row()).toMatchObject({
      auth: "key",
      sshKeyId: KEY_ID,
      sshFrom: "127.0.0.1",
      password: null,
      keyError: null,
    });
    // Installed over the password session, then proven by the key alone.
    expect(sshd.authMethods).toContain("password");
    expect(sshd.authMethods.at(-1)).toBe("publickey");
    expect(state.activity).toEqual([
      expect.objectContaining({
        actorId: USER_ID,
        action: "server.keyInstalled",
        entityType: "server",
        entityId: SERVER_ID,
        data: { server: "web-1", from: "127.0.0.1" },
      }),
    ]);
  });

  it("creates ~/.ssh 0700 and authorized_keys 0600 when missing", async () => {
    expect(await moveServerToKey(SERVER_ID, USER_ID)).toEqual({ ok: true });

    expect(statSync(join(sshd.home, ".ssh")).mode & 0o777).toBe(0o700);
    expect(statSync(authorizedKeys()).mode & 0o777).toBe(0o600);
    expect(readFileSync(authorizedKeys(), "utf8")).toBe(
      `${ourLine("127.0.0.1")}\n`
    );
  });

  it("verification failure rolls back", async () => {
    seedAuthorizedKeys(FOREIGN);
    sshd.rejectKey = true;

    expect(await moveServerToKey(SERVER_ID, USER_ID)).toEqual({
      ok: false,
      code: "keyLoginFailed",
    });

    expect(readFileSync(authorizedKeys(), "utf8")).toBe(`${FOREIGN}\n`);
    expect(row()).toMatchObject({
      auth: "password",
      password: "pw",
      sshKeyId: null,
      keyError: "keyLoginFailed",
    });
    expect(state.activity).toEqual([]);
  });

  it("rollback restores a line of ours that was there before", async () => {
    seedAuthorizedKeys(`${FOREIGN}\n${ourLine("10.9.9.9")}\n`);
    sshd.rejectKey = true;

    const result = await moveServerToKey(SERVER_ID, USER_ID);

    expect(result).toEqual({ ok: false, code: "keyLoginFailed" });
    expect(readFileSync(authorizedKeys(), "utf8")).toBe(
      `${FOREIGN}\n${ourLine("10.9.9.9")}\n`
    );
  });

  it("non-root without nopasswd refused", async () => {
    state.servers = [serverRow({ username: "deploy" })];

    expect(await moveServerToKey(SERVER_ID, USER_ID)).toEqual({
      ok: false,
      code: "sudoNeedsPassword",
    });

    expect(existsSync(join(sshd.home, ".ssh"))).toBe(false);
    expect(row()).toMatchObject({
      auth: "password",
      password: "pw",
      keyError: "sudoNeedsPassword",
    });
  });

  it("non-root with NOPASSWD sudo moves", async () => {
    state.servers = [serverRow({ username: "deploy" })];
    fakeSudo(true);

    expect(await moveServerToKey(SERVER_ID, USER_ID)).toEqual({ ok: true });
    expect(row().auth).toBe("key");
  });

  it("refuses symlinked .ssh", async () => {
    const elsewhere = join(root, `elsewhere-${homeCount}`);
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "authorized_keys"), FOREIGN);
    symlinkSync(elsewhere, join(sshd.home, ".ssh"));

    expect(await moveServerToKey(SERVER_ID, USER_ID)).toEqual({
      ok: false,
      code: "keyInstallFailed",
    });

    expect(readFileSync(join(elsewhere, "authorized_keys"), "utf8")).toBe(
      FOREIGN
    );
    expect(row()).toMatchObject({
      auth: "password",
      password: "pw",
      keyError: "keyInstallFailed",
    });
  });

  it("refuses a symlinked authorized_keys", async () => {
    mkdirSync(join(sshd.home, ".ssh"), { mode: 0o700 });
    const elsewhere = join(root, `target-${homeCount}`);
    writeFileSync(elsewhere, FOREIGN);
    symlinkSync(elsewhere, authorizedKeys());

    expect(await moveServerToKey(SERVER_ID, USER_ID)).toEqual({
      ok: false,
      code: "keyInstallFailed",
    });
    expect(readFileSync(elsewhere, "utf8")).toBe(FOREIGN);
  });

  it("reinstall uses password once", async () => {
    const once = "Once-Typed-Secret-9";
    state.servers = [
      serverRow({ auth: "key", password: null, sshKeyId: KEY_ID }),
    ];
    seedAuthorizedKeys(`${FOREIGN}\n${ourLine("10.9.9.9")}\n`);
    sshd.passwords.add(once);

    expect(
      await moveServerToKey(SERVER_ID, USER_ID, { passwordOnce: once })
    ).toEqual({ ok: true });

    expect(readFileSync(authorizedKeys(), "utf8")).toBe(
      `${FOREIGN}\n${ourLine("127.0.0.1")}\n`
    );
    expect(row()).toMatchObject({
      auth: "key",
      password: null,
      sshFrom: "127.0.0.1",
    });
    expect(JSON.stringify(state.servers)).not.toContain(once);
    expect(JSON.stringify(state.activity)).not.toContain(once);
    expect(state.activity).toEqual([
      expect.objectContaining({
        actorId: USER_ID,
        action: "server.keyReinstalled",
      }),
    ]);
  });

  it("a server without a password asks for one", async () => {
    state.servers = [serverRow({ password: null })];
    expect(await moveServerToKey(SERVER_ID, USER_ID)).toEqual({
      ok: false,
      code: "noPassword",
    });
    expect(sshd.authMethods).toEqual([]);
    expect(row().keyError).toBeNull();
  });

  it("a wrong password is reported as such", async () => {
    expect(
      await moveServerToKey(SERVER_ID, USER_ID, { passwordOnce: "wrong" })
    ).toEqual({ ok: false, code: "passwordRejected" });
    // The admin's typo, not the server's state: key_error is left alone.
    expect(row()).toMatchObject({ password: "pw", keyError: null });
  });

  it("an unreachable server keeps its password", async () => {
    state.port = 1;
    expect(await moveServerToKey(SERVER_ID, USER_ID)).toEqual({
      ok: false,
      code: "unreachable",
    });
    expect(row()).toMatchObject({ password: "pw", keyError: "unreachable" });
  });

  it("a mismatched host key refuses before any auth", async () => {
    state.servers = [
      serverRow({
        hostKey: otherHostBlob.toString("base64"),
        hostKeyFingerprint: sshFingerprint(otherHostBlob),
      }),
    ];
    expect(await moveServerToKey(SERVER_ID, USER_ID)).toEqual({
      ok: false,
      code: "hostKeyMismatch",
    });
    expect(sshd.authMethods).toEqual([]);
    expect(row()).toMatchObject({
      password: "pw",
      keyError: "hostKeyMismatch",
    });
  });

  it("own host uses subnet", async () => {
    process.env.OPSDECK_NETWORK_SUBNET = "172.29.0.0/16";
    sshd.sshClient = "172.29.0.7 51000 22";

    // The fake's key check ignores from=; the line is what matters here.
    expect(await moveServerToKey(SERVER_ID, USER_ID)).toEqual({ ok: true });

    expect(readFileSync(authorizedKeys(), "utf8")).toBe(
      `${ourLine("172.29.0.0/16")}\n`
    );
    expect(row().sshFrom).toBe("172.29.0.0/16");
  });

  it("an unusable $SSH_CLIENT installs nothing", async () => {
    sshd.sshClient = "";
    expect(await moveServerToKey(SERVER_ID, USER_ID)).toEqual({
      ok: false,
      code: "keyInstallFailed",
    });
    expect(existsSync(join(sshd.home, ".ssh"))).toBe(false);
  });

  it("never logs the password or the file", async () => {
    const once = "Logged-Secret-3";
    sshd.passwords.add(once);
    seedAuthorizedKeys(FOREIGN);
    sshd.rejectKey = true;
    await moveServerToKey(SERVER_ID, USER_ID, { passwordOnce: once });
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain("bluefin-romi");
    expect(logged).not.toContain(once);
    expect(logged).not.toContain("BEGIN OPENSSH");
  });

  it("a second concurrent key operation is refused", async () => {
    const results = await Promise.all([
      moveServerToKey(SERVER_ID, USER_ID),
      moveServerToKey(SERVER_ID, USER_ID),
    ]);
    expect(results).toContainEqual({ ok: true });
    expect(results).toContainEqual({ ok: false, code: "keyJobRunning" });
    expect(state.locks.size).toBe(0);
  });

  it("is refused while another process holds the lock", async () => {
    const release = await serverKeyLock(SERVER_ID);
    expect(release).not.toBeNull();
    expect(await moveServerToKey(SERVER_ID, USER_ID)).toEqual({
      ok: false,
      code: "keyJobRunning",
    });
    expect(sshd.authMethods).toEqual([]);
    expect(row().keyError).toBeNull();
    await release?.();
    expect(await moveServerToKey(SERVER_ID, USER_ID)).toEqual({ ok: true });
  });

  it("rollback skips removal when the row already committed", async () => {
    seedAuthorizedKeys(FOREIGN);
    sshd.rejectKey = true;
    // Another run commits the server to this key while ours is proving it.
    sshd.onKeyAuth = () => {
      Object.assign(row(), { auth: "key", sshKeyId: KEY_ID, password: null });
    };

    expect(await moveServerToKey(SERVER_ID, USER_ID)).toEqual({
      ok: false,
      code: "keyLoginFailed",
    });
    expect(readFileSync(authorizedKeys(), "utf8")).toBe(
      `${FOREIGN}\n${ourLine("127.0.0.1")}\n`
    );
  });

  it("a login edited meanwhile is not switched", async () => {
    seedAuthorizedKeys(FOREIGN);
    sshd.onKeyAuth = () => {
      row().username = "admin";
    };

    expect(await moveServerToKey(SERVER_ID, USER_ID)).toEqual({
      ok: false,
      code: "keyInstallFailed",
    });
    expect(row()).toMatchObject({ auth: "password", password: "pw" });
    expect(readFileSync(authorizedKeys(), "utf8")).toBe(`${FOREIGN}\n`);
  });

  it("a failure after the commit still answers ok", async () => {
    state.activityFails = true;
    expect(await moveServerToKey(SERVER_ID, USER_ID)).toEqual({ ok: true });
    expect(row()).toMatchObject({ auth: "key", keyError: null });
  });

  it("keeps foreign bytes that are not UTF-8", async () => {
    // Latin-1 "é", a lone UTF-8 lead byte before CRLF, and a cut-off
    // multibyte sequence at the end of the file.
    const foreign = Buffer.concat([
      Buffer.from("ssh-ed25519 AAAAC3Nza caf"),
      Buffer.from([0xe9, 0x0a]),
      Buffer.from("ssh-rsa AAAAB3 x"),
      Buffer.from([0xc3, 0x0d, 0x0a, 0xe2, 0x82]),
    ]);
    mkdirSync(join(sshd.home, ".ssh"), { mode: 0o700 });
    writeFileSync(authorizedKeys(), foreign);

    expect(await moveServerToKey(SERVER_ID, USER_ID)).toEqual({ ok: true });

    expect(readFileSync(authorizedKeys())).toEqual(
      Buffer.concat([foreign, Buffer.from(`\n${ourLine("127.0.0.1")}\n`)])
    );
  });

  it("refuses a ~/.ssh writable by others", async () => {
    seedAuthorizedKeys(FOREIGN);
    chmodSync(join(sshd.home, ".ssh"), 0o777);

    expect(await moveServerToKey(SERVER_ID, USER_ID)).toEqual({
      ok: false,
      code: "sshDirUnsafe",
    });
    expect(readFileSync(authorizedKeys(), "utf8")).toBe(FOREIGN);
    expect(row()).toMatchObject({ password: "pw", keyError: "sshDirUnsafe" });
  });
});

describe("normaliseSubnet", () => {
  it("zeroes host bits", () => {
    expect(normaliseSubnet("172.29.5.7/16")).toBe("172.29.0.0/16");
    expect(normaliseSubnet(" 10.1.2.3/8 ")).toBe("10.0.0.0/8");
    expect(normaliseSubnet("192.168.56.113/32")).toBe("192.168.56.113/32");
    expect(normaliseSubnet("fd00:1::5/64")).toBe("fd00:1:0:0:0:0:0:0/64");
  });

  it("rejects subnets that are too wide or malformed", () => {
    for (const bad of [
      "10.0.0.0/7",
      "0.0.0.0/0",
      "fd00::/31",
      "172.29.0.0",
      "172.29.0.0/33",
      "nope/16",
      "fe80::1%eth0/64",
      "1.2.3.4/16/1",
    ]) {
      expect(normaliseSubnet(bad), bad).toBeNull();
    }
  });
});

describe("ownSubnet", () => {
  // /proc/net/route of a container in a compose network 172.29.0.0/16: the
  // default route and the connected route of eth0 (little-endian hex).
  const ROUTES = [
    "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
    "eth0\t00000000\t01001DAC\t0003\t0\t0\t0\t00000000\t0\t0\t0",
    "eth0\t00001DAC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0",
    "eth1\t000012AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0",
    "",
  ].join("\n");

  it("prefers OPSDECK_NETWORK_SUBNET", () => {
    expect(
      ownSubnet({
        env: { OPSDECK_NETWORK_SUBNET: "10.5.0.0/24" },
        inContainer: () => true,
        routeTable: () => ROUTES,
      })
    ).toBe("10.5.0.0/24");
  });

  it("falls back to the container's connected route", () => {
    expect(
      ownSubnet({
        env: {},
        inContainer: () => true,
        routeTable: () => ROUTES,
      })
    ).toBe("172.29.0.0/16");
  });

  it("uses no subnet outside a container", () => {
    expect(
      ownSubnet({
        env: {},
        inContainer: () => false,
        routeTable: () => ROUTES,
      })
    ).toBeNull();
  });

  it("normalises the env subnet and refuses one that is too wide", () => {
    const source = { inContainer: () => true, routeTable: () => ROUTES };
    expect(
      ownSubnet({ ...source, env: { OPSDECK_NETWORK_SUBNET: "10.5.0.9/24" } })
    ).toBe("10.5.0.0/24");
    // Too wide: no subnet at all (from= is the plain address), not the route.
    expect(
      ownSubnet({ ...source, env: { OPSDECK_NETWORK_SUBNET: "0.0.0.0/0" } })
    ).toBeNull();
  });

  // One /proc/net/route line: interface, destination, gateway, flags, mask.
  const route = (
    iface: string,
    dest: string,
    gw: string,
    flags: string,
    mask: string
  ) => `${iface}\t${dest}\t${gw}\t${flags}\t0\t0\t0\t${mask}\t0\t0\t0`;
  const table = (...lines: string[]) =>
    [ROUTES.split("\n")[0], ...lines, ""].join("\n");
  const inContainer = { env: {}, inContainer: () => true };

  it("refuses a host-network container (host bridges visible)", () => {
    const hostNet = table(
      route("eth0", "00000000", "0138A8C0", "0003", "00000000"),
      route("eth0", "0038A8C0", "00000000", "0001", "00FFFFFF"),
      route("docker0", "000011AC", "00000000", "0001", "0000FFFF")
    );
    expect(ownSubnet({ ...inContainer, routeTable: () => hostNet })).toBeNull();
  });

  it("refuses a public or oddly gated connected route", () => {
    // 203.0.113.0/24, gateway .1: not private.
    const publicNet = table(
      route("eth0", "00000000", "017100CB", "0003", "00000000"),
      route("eth0", "007100CB", "00000000", "0001", "00FFFFFF")
    );
    // 172.29.0.0/16 with the gateway at .254: not a bridge's numbering.
    const oddGateway = table(
      route("eth0", "00000000", "FE001DAC", "0003", "00000000"),
      route("eth0", "00001DAC", "00000000", "0001", "0000FFFF")
    );
    // 10.0.0.0/8: wider than /12.
    const tooWide = table(
      route("eth0", "00000000", "0100000A", "0003", "00000000"),
      route("eth0", "0000000A", "00000000", "0001", "000000FF")
    );
    for (const t of [publicNet, oddGateway, tooWide]) {
      expect(ownSubnet({ ...inContainer, routeTable: () => t })).toBeNull();
    }
  });

  it("ignores an unreadable or routeless table", () => {
    const source = { env: {}, inContainer: () => true };
    expect(ownSubnet({ ...source, routeTable: () => null })).toBeNull();
    expect(
      ownSubnet({ ...source, routeTable: () => ROUTES.split("\n")[0] ?? "" })
    ).toBeNull();
  });
});

const post = (path: string, body: unknown = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("routes", () => {
  it("non-admin gets 403", async () => {
    state.orgRole = "member";
    for (const [path, body] of [
      ["move-to-key", {}],
      ["reinstall-key", { password: "pw" }],
      ["trust-host-key", { expectedFingerprint: "SHA256:x" }],
    ] as const) {
      const res = await post(`/api/servers/${SERVER_ID}/${path}`, body);
      expect(res.status).toBe(403);
    }
    expect(sshd.authMethods).toEqual([]);
    expect(row()).toMatchObject({ auth: "password", password: "pw" });
  });

  it("move-to-key answers ok, and a failure with its code", async () => {
    expect(
      await (await post(`/api/servers/${SERVER_ID}/move-to-key`)).json()
    ).toEqual({ ok: true });

    state.servers = [serverRow()];
    sshd.home = join(root, `home-r-${homeCount}`);
    mkdirSync(sshd.home);
    sshd.rejectKey = true;
    const res = await post(`/api/servers/${SERVER_ID}/move-to-key`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "keyLoginFailed",
      code: "keyLoginFailed",
    });
  });

  it("a key operation already running answers 409 keyJobRunning", async () => {
    const release = await serverKeyLock(SERVER_ID);
    const res = await post(`/api/servers/${SERVER_ID}/move-to-key`);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("keyJobRunning");
    await release?.();
  });

  it("reinstall-key requires a password", async () => {
    const res = await post(`/api/servers/${SERVER_ID}/reinstall-key`, {});
    expect(res.status).toBe(400);
  });

  it("trust re-pins", async () => {
    // The server now offers another host key: refused and recorded.
    state.servers = [
      serverRow({
        hostKey: otherHostBlob.toString("base64"),
        hostKeyFingerprint: sshFingerprint(otherHostBlob),
      }),
    ];
    expect(await moveServerToKey(SERVER_ID, USER_ID)).toEqual({
      ok: false,
      code: "hostKeyMismatch",
    });
    expect(row().hostKeyOfferedFingerprint).toBe(sshFingerprint(hostBlob));

    const stale = await post(`/api/servers/${SERVER_ID}/trust-host-key`, {
      expectedFingerprint: sshFingerprint(otherHostBlob),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("hostKeyChanged");

    const res = await post(`/api/servers/${SERVER_ID}/trust-host-key`, {
      expectedFingerprint: sshFingerprint(hostBlob),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(row()).toMatchObject({
      hostKey: hostBlob.toString("base64"),
      hostKeyFingerprint: sshFingerprint(hostBlob),
      hostKeyOfferedFingerprint: null,
      keyError: null,
    });
    expect(state.activity).toContainEqual(
      expect.objectContaining({
        actorId: USER_ID,
        action: "server.hostKeyTrusted",
      })
    );

    // The re-pinned key is accepted: the move now goes through.
    expect(await moveServerToKey(SERVER_ID, USER_ID)).toEqual({ ok: true });
  });
});
