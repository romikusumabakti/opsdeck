import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
import { parseableKeyPair } from "@/lib/ssh-keypair";

// Move all and rotate against three real in-process sshds (ssh2's Server),
// one per server, each running commands with /bin/sh in its own temp home: the
// scripts really edit a real authorized_keys, and a key login is accepted only
// for a key that file holds. The tables (servers, ssh_keys, ssh_key_jobs) are
// in memory, with the one-open-job and one-current-key unique indexes, and the
// advisory locks are a set.

type Row = Record<string, unknown>;
type Cond =
  | { op: "eq"; key: string; value: unknown }
  | { op: "ne"; key: string; value: unknown }
  | { op: "isNull"; key: string }
  | { op: "exists"; sub: { rowsNow: () => Row[] } }
  | { op: "notExists"; sub: { rowsNow: () => Row[] } }
  | { op: "and" | "or"; conds: (Cond | undefined)[] };
type Order = { op: "asc" | "desc"; key: string };

const USER_ID = "0197f3a0-1b2c-7def-8000-0123456789b1";
const OLD_KEY_ID = "0197f3a0-1b2c-7def-8000-0000000000aa";
const IDS = [
  "0197f3a0-1b2c-7def-8000-000000000001",
  "0197f3a0-1b2c-7def-8000-000000000002",
  "0197f3a0-1b2c-7def-8000-000000000003",
];

const state = vi.hoisted(() => ({
  tables: {
    servers: [] as Record<string, unknown>[],
    ssh_keys: [] as Record<string, unknown>[],
    ssh_key_jobs: [] as Record<string, unknown>[],
    // Read by the org guards' membership lookup.
    projects: [] as Record<string, unknown>[],
    project_members: [] as Record<string, unknown>[],
  },
  activity: [] as Record<string, unknown>[],
  enqueued: [] as { name: string; data: unknown; options: unknown }[],
  // BullMQ job ids still in the queue.
  queued: new Set<string>(),
  // Advisory locks held, keyed by their two halves.
  locks: new Set<string>(),
  ports: {} as Record<string, number>,
  orgRole: "admin",
  // Text of every raw query sent through pgClient.
  rawQueries: [] as string[],
  // Make db.transaction throw (a database error during a commit).
  txFails: false,
  // Replaces the lock connection lockConnection opens (null: the fake below).
  lockConnection: null as null | ((onclose: () => void) => unknown),
}));

const camel = (name: string) =>
  name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  const isColumn = (c: unknown): c is { name: string } =>
    typeof (c as { name?: unknown } | null)?.name === "string";
  const wrap =
    (op: string, real: (...args: never[]) => unknown) =>
    (column: unknown, ...rest: unknown[]) =>
      isColumn(column)
        ? { op, key: camel(column.name), value: rest[0] }
        : real(...([column, ...rest] as never[]));
  return {
    ...actual,
    eq: wrap("eq", actual.eq as never),
    ne: wrap("ne", actual.ne as never),
    isNull: wrap("isNull", actual.isNull as never),
    asc: wrap("asc", actual.asc as never),
    desc: wrap("desc", actual.desc as never),
    and: (...conds: unknown[]) => ({ op: "and", conds }),
    or: (...conds: unknown[]) => ({ op: "or", conds }),
    exists: (sub: unknown) => ({ op: "exists", sub }),
    notExists: (sub: unknown) => ({ op: "notExists", sub }),
  };
});

vi.mock("@/lib/db", async () => {
  const { getTableName } =
    await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  const rowsOf = (table: unknown) => {
    const rows = (state.tables as Record<string, Row[]>)[
      getTableName(table as never)
    ];
    if (!rows)
      throw new Error(`table not faked: ${getTableName(table as never)}`);
    return rows;
  };
  const matches = (row: Row, cond: Cond | undefined): boolean => {
    if (!cond) return true;
    if (cond.op === "eq") return row[cond.key] === cond.value;
    if (cond.op === "ne") {
      return row[cond.key] != null && row[cond.key] !== cond.value;
    }
    if (cond.op === "isNull") return row[cond.key] == null;
    if (cond.op === "exists") return cond.sub.rowsNow().length > 0;
    if (cond.op === "notExists") return cond.sub.rowsNow().length === 0;
    if (cond.op === "or") return cond.conds.some((c) => matches(row, c));
    return cond.conds.every((c) => matches(row, c));
  };
  const copy = (r: Row) => structuredClone(r);
  const selectFrom = (table: unknown) => {
    let cond: Cond | undefined;
    let order: Order | undefined;
    const rowsNow = () => {
      const rows = rowsOf(table).filter((r) => matches(r, cond));
      if (order) {
        const { key, op } = order;
        rows.sort((a, b) => {
          const x = a[key] as string | number | Date;
          const y = b[key] as string | number | Date;
          const c = x < y ? -1 : x > y ? 1 : 0;
          return op === "asc" ? c : -c;
        });
      }
      return rows.map(copy);
    };
    const run = async () => rowsNow();
    const q = {
      rowsNow,
      for: () => q,
      where: (c: Cond) => {
        cond = c;
        return q;
      },
      orderBy: (o: Order) => {
        order = o;
        return q;
      },
      limit: async (n: number) => (await run()).slice(0, n),
      // biome-ignore lint/suspicious/noThenProperty: awaitable like a drizzle query
      then: (ok: (rows: Row[]) => unknown, fail: (e: unknown) => unknown) =>
        run().then(ok, fail),
    };
    return q;
  };
  const awaitable = (run: () => Promise<Row[]>) => ({
    returning: run,
    // biome-ignore lint/suspicious/noThenProperty: awaitable like a drizzle query
    then: (ok: (rows: Row[]) => unknown, fail: (e: unknown) => unknown) =>
      run().then(ok, fail),
  });
  const defaults: Record<string, () => Row> = {
    ssh_keys: () => ({ status: "current", createdAt: new Date() }),
    ssh_key_jobs: () => ({
      requestedAt: new Date(Date.now() + state.tables.ssh_key_jobs.length),
      startedAt: null,
      finishedAt: null,
      results: [],
      errorCode: null,
    }),
  };
  // The partial unique indexes: one current key, one open job.
  const conflicts = (name: string, row: Row) =>
    (name === "ssh_keys" &&
      row.status === "current" &&
      state.tables.ssh_keys.some((r) => r.status === "current")) ||
    (name === "ssh_key_jobs" &&
      state.tables.ssh_key_jobs.some((r) => r.finishedAt == null));
  const insert = (table: unknown) => ({
    values: (values: Row) => {
      const name = getTableName(table as never);
      let ignore = false;
      const run = async () => {
        const row = {
          id: crypto.randomUUID(),
          ...defaults[name]?.(),
          ...values,
        };
        if (conflicts(name, row)) {
          if (ignore) return [];
          throw Object.assign(new Error("unique violation"), { code: "23505" });
        }
        rowsOf(table).push(row);
        return [copy(row)];
      };
      const q = {
        ...awaitable(run),
        onConflictDoNothing: () => {
          ignore = true;
          return awaitable(run);
        },
      };
      return q;
    },
  });
  const db = {
    select: () => ({ from: selectFrom }),
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: (cond: Cond) =>
          awaitable(async () => {
            const hit = rowsOf(table).filter((r) => matches(r, cond));
            for (const r of hit) Object.assign(r, structuredClone(values));
            return hit.map(copy);
          }),
      }),
    }),
    insert,
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
      if (state.txFails) throw new Error("connection lost");
      return fn(db);
    },
  };
  const lockQuery = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const text = strings.join("?");
    state.rawQueries.push(text);
    const key = values.join(":");
    if (text.includes("pg_try_advisory_lock")) {
      if (state.locks.has(key)) return [{ locked: false }];
      state.locks.add(key);
      return [{ locked: true }];
    }
    if (text.includes("pg_advisory_unlock")) state.locks.delete(key);
    if (text.includes("pg_locks")) return [{ held: state.locks.has(key) }];
    return [];
  };
  const client = (strings: TemplateStringsArray, ...values: unknown[]) =>
    lockQuery(strings, ...values);
  const lockConnection = (onclose: () => void) =>
    state.lockConnection?.(onclose) ??
    Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) =>
        lockQuery(strings, ...values),
      { end: async () => {} }
    );
  return { db, pgClient: () => client, lockConnection };
});

vi.mock("@/lib/secrets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/secrets")>()),
  // Stored as plaintext, which decryptSecret returns verbatim.
  encryptSecret: (plaintext: string) => plaintext,
}));

vi.mock("@/lib/queue", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  enqueue: vi.fn(async (name: string, data: unknown, options: unknown) => {
    state.enqueued.push({ name, data, options });
    state.queued.add((options as { jobId: string }).jobId);
  }),
  jobExists: vi.fn(async (id: string) => state.queued.has(id)),
}));

vi.mock("@/lib/activity", () => ({
  recordActivity: async (input: Record<string, unknown>) => {
    state.activity.push(input);
  },
}));

// Real servers listen on 22; here each server has its own in-process sshd.
vi.mock("@/lib/ssh-connect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ssh-connect")>();
  return {
    ...actual,
    sshTarget: (row: Parameters<typeof actual.sshTarget>[0]) => ({
      ...actual.sshTarget(row),
      port: state.ports[row.id],
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
// The real requireOrgPermission, over the session above.
vi.mock("@/server/i18n", () => ({
  getServerTranslator: async () => (key: string) => key,
}));

const { beginRotation, keyJobLock, retireKey, serverKeyLock, sshFingerprint } =
  await import("@/lib/ssh-keys");
const { moveServerToKey, rotateServerKey } = await import(
  "@/server/services/server-keys"
);
const { processJob } = await import("@/lib/jobs/processor");
const { app } = await import("@/server/app");

const hostKey = parseableKeyPair();
const hostBlob = Buffer.from(hostKey.public.split(" ")[1] ?? "", "base64");
const oldKey = parseableKeyPair();
const oldBase64 = oldKey.public.split(" ")[1] ?? "";
const OLD_MARKER = `opsdeck:opsdeck:${OLD_KEY_ID}`;
const FOREIGN = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRomi romi@bluefin-romi";

type Sshd = {
  server: ssh2.Server;
  // Each server its own loopback address: rows on one host and login share
  // one authorized_keys, so the fixtures keep them apart.
  host: string;
  port: number;
  home: string;
  passwords: Set<string>;
  // Accept only the old key (the new one is "not accepted" by this server).
  oldKeyOnly: boolean;
  keysOffered: string[];
  // authorized_keys writes allowed before they start failing (null: all).
  writesAllowed: number | null;
  // Runs on every publickey attempt, to interleave a concurrent change.
  onKeyAuth: (() => void) | null;
};

let root: string;
const sshds: Sshd[] = [];

const authorizedKeys = (d: Sshd) => join(d.home, ".ssh", "authorized_keys");
const fileOf = (i: number) =>
  readFileSync(authorizedKeys(sshds[i] as Sshd), "utf8");

function startSshd(d: Sshd): Promise<ssh2.Server> {
  const server = new ssh2.Server({ hostKeys: [hostKey.private] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && d.passwords.has(ctx.password)) {
        ctx.accept();
        return;
      }
      if (ctx.method === "publickey") {
        const offered = ctx.key.data.toString("base64");
        d.keysOffered.push(offered);
        d.onKeyAuth?.();
        const file = authorizedKeys(d);
        const listed =
          existsSync(file) &&
          readFileSync(file, "utf8")
            .split("\n")
            .some((line) => line.includes(` ${offered} `));
        if (listed && (!d.oldKeyOnly || offered === oldBase64)) {
          ctx.accept();
          return;
        }
      }
      ctx.reject(["password", "publickey"]);
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          if (info.command.includes(".authorized_keys.opsdeck.")) {
            if (d.writesAllowed !== null && d.writesAllowed-- <= 0) {
              stream.exit(23);
              stream.end();
              return;
            }
          }
          const child = spawn("/bin/sh", ["-c", info.command], {
            env: {
              HOME: d.home,
              SSH_CLIENT: "127.0.0.1 51000 22",
              PATH: "/usr/bin:/bin",
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
    server.listen(0, d.host, () => resolve(server));
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "opsdeck-key-jobs-"));
  for (let i = 0; i < 3; i++) {
    const d = {
      host: `127.0.0.${i + 1}`,
      port: 0,
      home: "",
      passwords: new Set<string>(),
      oldKeyOnly: false,
      keysOffered: [],
    } as unknown as Sshd;
    d.server = await startSshd(d);
    d.port = (d.server.address() as { port: number }).port;
    sshds.push(d);
  }
});

afterAll(() => {
  for (const d of sshds) d.server.close();
  rmSync(root, { recursive: true, force: true });
});

function serverRow(i: number, overrides: Row = {}): Row {
  return {
    id: IDS[i],
    name: `web-${i + 1}`,
    host: `127.0.0.${i + 1}`,
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

const oldLine = `from="127.0.0.1",no-agent-forwarding,no-X11-forwarding ssh-ed25519 ${oldBase64} ${OLD_MARKER}`;

/** Three servers already on the old key: its line next to a foreign one. */
function seedKeyServers() {
  state.tables.servers = [0, 1, 2].map((i) =>
    serverRow(i, {
      auth: "key",
      password: null,
      sshKeyId: OLD_KEY_ID,
      sshFrom: "127.0.0.1",
    })
  );
  for (const d of sshds) {
    mkdirSync(join(d.home, ".ssh"), { mode: 0o700 });
    writeFileSync(authorizedKeys(d), `${FOREIGN}\n${oldLine}\n`, {
      mode: 0o600,
    });
  }
}

const keyRow = (status: string) =>
  state.tables.ssh_keys.find((k) => k.status === status) as Row | undefined;
const serverById = (i: number) =>
  state.tables.servers.find((s) => s.id === IDS[i]) as Row;
const lastJob = () =>
  state.tables.ssh_key_jobs.at(-1) as Row & { results: Row[] };
const markerOf = (keyId: unknown) => `opsdeck:opsdeck:${String(keyId)}`;
const NEW_KEY_ID = "0197f3a0-1b2c-7def-8000-0000000000bb";
const DEAD_KEY_ID = "0197f3a0-1b2c-7def-8000-00000000dead";
// Another Panel deployment with the same default instance name: its key id
// is not in this database.
const OTHER_PANEL = `ssh-ed25519 ${parseableKeyPair().public.split(" ")[1]} opsdeck:opsdeck:0197f3a0-1b2c-7def-8000-0000000f0e19`;

/** A key this database once had, retired since. */
function retiredKey() {
  state.tables.ssh_keys.push({
    id: DEAD_KEY_ID,
    publicKey: parseableKeyPair().public,
    privateKey: "",
    fingerprint: "SHA256:dead",
    status: "retired",
  });
}

let homeCount = 0;
beforeEach(() => {
  state.tables.servers = [0, 1, 2].map((i) => serverRow(i));
  state.tables.ssh_keys = [
    {
      id: OLD_KEY_ID,
      publicKey: oldKey.public,
      privateKey: oldKey.private,
      fingerprint: "SHA256:old",
      status: "current",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
  ];
  state.tables.ssh_key_jobs = [];
  state.activity = [];
  state.enqueued = [];
  state.queued = new Set();
  state.locks = new Set();
  state.rawQueries = [];
  state.txFails = false;
  state.lockConnection = null;
  state.orgRole = "admin";
  for (const [i, d] of sshds.entries()) {
    homeCount += 1;
    d.home = join(root, `home-${homeCount}`);
    mkdirSync(d.home);
    d.passwords = new Set(["pw"]);
    d.oldKeyOnly = false;
    d.keysOffered = [];
    d.writesAllowed = null;
    d.onKeyAuth = null;
    state.ports[IDS[i] as string] = d.port;
  }
  delete process.env.OPSDECK_NETWORK_SUBNET;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const request = (method: string, path: string) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(method === "POST" ? { body: "{}" } : {}),
  });

/** What the worker does with the job the last request queued. */
async function runQueued() {
  const job = state.enqueued.at(-1);
  if (!job) throw new Error("nothing queued");
  state.queued.delete((job.options as { jobId: string }).jobId);
  return processJob({ name: job.name, data: job.data } as never);
}

describe("move all", () => {
  it("move-all continues past failures", async () => {
    // The middle server rejects the stored password.
    (sshds[1] as Sshd).passwords = new Set(["other"]);

    const res = await request("POST", "/api/instance/ssh-key/move-all");
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: true });
    const keyJobId = lastJob().id;
    expect(state.enqueued).toEqual([
      {
        name: "server-key-move-all",
        data: { keyJobId },
        options: { jobId: keyJobId },
      },
    ]);

    expect(await runQueued()).toEqual({ status: "done" });

    expect(lastJob()).toMatchObject({
      kind: "moveAll",
      actorId: USER_ID,
      errorCode: null,
      results: [
        { serverId: IDS[0], name: "web-1", ok: true, code: null },
        {
          serverId: IDS[1],
          name: "web-2",
          ok: false,
          code: "passwordRejected",
        },
        { serverId: IDS[2], name: "web-3", ok: true, code: null },
      ],
    });
    expect(lastJob().startedAt).toBeInstanceOf(Date);
    expect(lastJob().finishedAt).toBeInstanceOf(Date);
    expect(serverById(0)).toMatchObject({ auth: "key", password: null });
    expect(serverById(1)).toMatchObject({ auth: "password", password: "pw" });
    expect(serverById(2)).toMatchObject({ auth: "key", password: null });
    expect(state.activity.map((a) => [a.action, a.actorId])).toEqual([
      ["server.keyInstalled", USER_ID],
      ["server.keyInstalled", USER_ID],
    ]);
    // Nothing is left locked.
    expect(state.locks.size).toBe(0);

    // The results outlive the worker: GET reads them back from the table.
    const got = await (await request("GET", "/api/instance/ssh-key")).json();
    expect(got).toMatchObject({
      publicKey: oldKey.public,
      fingerprint: "SHA256:old",
      lastJob: {
        kind: "moveAll",
        errorCode: null,
        results: [
          { ok: true },
          { ok: false, code: "passwordRejected" },
          { ok: true },
        ],
      },
    });
    expect(got).not.toHaveProperty("previous");
    expect(JSON.stringify(got)).not.toContain("PRIVATE KEY");
  });

  it("only takes password servers", async () => {
    state.tables.servers = [
      serverRow(0),
      serverRow(1, { auth: "key", password: null, sshKeyId: OLD_KEY_ID }),
    ];
    await request("POST", "/api/instance/ssh-key/move-all");
    await runQueued();
    expect(lastJob().results).toEqual([
      { serverId: IDS[0], name: "web-1", ok: true, code: null },
    ]);
  });
});

describe("rotate", () => {
  it("rotate keeps old key until every server succeeds", async () => {
    seedKeyServers();
    // The middle server does not accept the new key.
    (sshds[1] as Sshd).oldKeyOnly = true;

    const res = await request("POST", "/api/instance/ssh-key/rotate");
    expect(res.status).toBe(202);
    expect(state.enqueued.at(-1)?.name).toBe("server-key-rotate");
    expect(await runQueued()).toEqual({ status: "done" });

    const current = keyRow("current") as Row;
    expect(current.id).not.toBe(OLD_KEY_ID);
    expect(keyRow("previous")?.id).toBe(OLD_KEY_ID);
    const newBase64 = String(current.publicKey).split(" ")[1];
    const newLine = `from="127.0.0.1",no-agent-forwarding,no-X11-forwarding ssh-ed25519 ${newBase64} ${markerOf(current.id)}`;

    expect(lastJob().results).toEqual([
      { serverId: IDS[0], name: "web-1", ok: true, code: null },
      { serverId: IDS[1], name: "web-2", ok: false, code: "keyLoginFailed" },
      { serverId: IDS[2], name: "web-3", ok: true, code: null },
    ]);
    // Done servers: the new line only, other lines untouched.
    for (const i of [0, 2]) {
      expect(fileOf(i)).toBe(`${FOREIGN}\n${newLine}\n`);
      expect(serverById(i)).toMatchObject({
        sshKeyId: current.id,
        keyError: null,
      });
    }
    // The failed server keeps its old line and its old key, and no key_error:
    // it still signs in with the old key.
    expect(fileOf(1)).toBe(`${FOREIGN}\n${oldLine}\n`);
    expect(serverById(1)).toMatchObject({
      sshKeyId: OLD_KEY_ID,
      keyError: null,
    });
    // Every server was reached with the key it had, then proven with the new.
    for (const d of sshds) {
      expect(d.keysOffered[0]).toBe(oldBase64);
      expect(d.keysOffered.at(-1)).toBe(newBase64);
    }
    expect(state.activity).toEqual([
      expect.objectContaining({
        action: "server.keyRotated",
        actorId: USER_ID,
        entityId: IDS[0],
        data: { server: "web-1", from: "127.0.0.1" },
      }),
      expect.objectContaining({
        action: "server.keyRotated",
        entityId: IDS[2],
      }),
    ]);

    const got = await (await request("GET", "/api/instance/ssh-key")).json();
    expect(got).toMatchObject({
      publicKey: current.publicKey,
      previous: { fingerprint: "SHA256:old" },
      lastJob: { kind: "rotate" },
    });

    // Rotating again resumes: no new key, the server left over is rotated,
    // the others are checked with the new key for a leftover old line, and
    // the old key is retired once no server holds it.
    (sshds[1] as Sshd).oldKeyOnly = false;
    for (const d of sshds) d.keysOffered = [];
    await request("POST", "/api/instance/ssh-key/rotate");
    await runQueued();

    expect(state.tables.ssh_keys).toHaveLength(2);
    expect(keyRow("current")?.id).toBe(current.id);
    expect(keyRow("previous")).toBeUndefined();
    expect(state.tables.ssh_keys.find((k) => k.id === OLD_KEY_ID)?.status).toBe(
      "retired"
    );
    expect(lastJob().results).toEqual([
      { serverId: IDS[0], name: "web-1", ok: true, code: null },
      { serverId: IDS[1], name: "web-2", ok: true, code: null },
      { serverId: IDS[2], name: "web-3", ok: true, code: null },
    ]);
    expect(fileOf(1)).toBe(`${FOREIGN}\n${newLine}\n`);
    // A server already on the new key is reached with it, not the old one.
    expect([...new Set((sshds[0] as Sshd).keysOffered)]).toEqual([newBase64]);
    expect(
      (await (await request("GET", "/api/instance/ssh-key")).json()).previous
    ).toBeUndefined();
  });

  it("a failed rotate, a reinstall, then rotate: retired only when no old line remains", async () => {
    seedKeyServers();
    (sshds[1] as Sshd).oldKeyOnly = true;
    await request("POST", "/api/instance/ssh-key/rotate");
    await runQueued();
    const current = keyRow("current") as Row;
    const newLine = `from="127.0.0.1",no-agent-forwarding,no-X11-forwarding ssh-ed25519 ${String(current.publicKey).split(" ")[1]} ${markerOf(current.id)}`;

    // The documented recovery: reinstall with the password typed once. Our
    // other instance lines (the old key's) go with it.
    (sshds[1] as Sshd).oldKeyOnly = false;
    expect(
      await moveServerToKey(IDS[1] as string, USER_ID, { passwordOnce: "pw" })
    ).toEqual({ ok: true });
    expect(fileOf(1)).toBe(`${FOREIGN}\n${newLine}\n`);

    await request("POST", "/api/instance/ssh-key/rotate");
    await runQueued();
    expect(state.tables.ssh_keys.find((k) => k.id === OLD_KEY_ID)?.status).toBe(
      "retired"
    );
    for (const i of [0, 1, 2]) expect(fileOf(i)).not.toContain(OLD_MARKER);
  });

  it("an old line that cannot be removed fails the server and keeps previous", async () => {
    seedKeyServers();
    // web-3: the write adding the new line lands, the one removing the old
    // line fails.
    (sshds[2] as Sshd).writesAllowed = 1;
    await request("POST", "/api/instance/ssh-key/rotate");
    await runQueued();
    const current = keyRow("current") as Row;
    expect(lastJob().results[2]).toEqual({
      serverId: IDS[2],
      name: "web-3",
      ok: false,
      code: "oldKeyNotRemoved",
    });
    // It signs in with the new key; the old line is still there.
    expect(serverById(2)).toMatchObject({ sshKeyId: current.id });
    expect(fileOf(2)).toContain(OLD_MARKER);
    expect(keyRow("previous")?.id).toBe(OLD_KEY_ID);

    // The next rotation finds the leftover line and removes it.
    (sshds[2] as Sshd).writesAllowed = null;
    await request("POST", "/api/instance/ssh-key/rotate");
    await runQueued();
    expect(lastJob().results.map((r: Row) => r.ok)).toEqual([true, true, true]);
    expect(fileOf(2)).not.toContain(OLD_MARKER);
    expect(state.tables.ssh_keys.find((k) => k.id === OLD_KEY_ID)?.status).toBe(
      "retired"
    );
  });

  it("a move drops a stale line of this database's other keys only", async () => {
    retiredKey();
    mkdirSync(join((sshds[0] as Sshd).home, ".ssh"), { mode: 0o700 });
    const stale = `from="127.0.0.1",no-agent-forwarding,no-X11-forwarding ssh-ed25519 ${oldBase64} opsdeck:opsdeck:${DEAD_KEY_ID}`;
    const otherInstance = `ssh-ed25519 ${oldBase64} opsdeck:beta:0197f3a0-1b2c-7def-8000-00000000beef`;
    writeFileSync(
      authorizedKeys(sshds[0] as Sshd),
      `${FOREIGN}\n${stale}\n${otherInstance}\n${OTHER_PANEL}\n`
    );
    expect(await moveServerToKey(IDS[0] as string, USER_ID)).toEqual({
      ok: true,
    });
    expect(fileOf(0)).toBe(
      `${FOREIGN}\n${otherInstance}\n${OTHER_PANEL}\n${oldLine}\n`
    );
  });

  it("another Panel's line with the same prefix survives move, reinstall and rotate", async () => {
    mkdirSync(join((sshds[0] as Sshd).home, ".ssh"), { mode: 0o700 });
    writeFileSync(
      authorizedKeys(sshds[0] as Sshd),
      `${FOREIGN}\n${OTHER_PANEL}\n`
    );
    state.tables.servers = [serverRow(0)];

    await request("POST", "/api/instance/ssh-key/move-all");
    await runQueued();
    expect(lastJob().results[0]).toMatchObject({ ok: true });
    expect(fileOf(0)).toContain(OTHER_PANEL);

    expect(
      await moveServerToKey(IDS[0] as string, USER_ID, { passwordOnce: "pw" })
    ).toEqual({ ok: true });
    expect(fileOf(0)).toContain(OTHER_PANEL);

    await request("POST", "/api/instance/ssh-key/rotate");
    await runQueued();
    expect(lastJob().results[0]).toMatchObject({ ok: true });
    expect(fileOf(0)).toContain(OTHER_PANEL);
    expect(fileOf(0)).not.toContain(OLD_MARKER);
  });

  it("a reinstall keeps the line of the key the row uses until it commits", async () => {
    // Mid-rotation: the row is on the old key, a new key is current, and the
    // new key's proof fails; the undo's write fails too.
    seedKeyServers();
    (state.tables.ssh_keys[0] as Row).status = "previous";
    const unusable = parseableKeyPair();
    state.tables.ssh_keys.push({
      id: NEW_KEY_ID,
      publicKey: unusable.public,
      privateKey: parseableKeyPair().private,
      fingerprint: "SHA256:new",
      status: "current",
    });
    (sshds[0] as Sshd).writesAllowed = 1;
    expect(
      await moveServerToKey(IDS[0] as string, USER_ID, { passwordOnce: "pw" })
    ).toEqual({ ok: false, code: "keyLoginFailed" });
    expect(fileOf(0)).toContain(oldLine);
    expect(serverById(0)).toMatchObject({ sshKeyId: OLD_KEY_ID });
  });

  it("a move whose commit throws is undone", async () => {
    seedKeyServers();
    (state.tables.ssh_keys[0] as Row).status = "previous";
    const fresh = parseableKeyPair();
    state.tables.ssh_keys.push({
      id: NEW_KEY_ID,
      publicKey: fresh.public,
      privateKey: fresh.private,
      fingerprint: "SHA256:new",
      status: "current",
    });
    state.txFails = true;
    expect(
      await moveServerToKey(IDS[0] as string, USER_ID, { passwordOnce: "pw" })
    ).toEqual({ ok: false, code: "keyInstallFailed" });
    expect(fileOf(0)).toBe(`${FOREIGN}\n${oldLine}\n`);
    expect(serverById(0)).toMatchObject({ sshKeyId: OLD_KEY_ID });
  });

  it("a failed move puts back the stale lines it dropped", async () => {
    retiredKey();
    mkdirSync(join((sshds[0] as Sshd).home, ".ssh"), { mode: 0o700 });
    const stale = `ssh-ed25519 ${oldBase64} opsdeck:opsdeck:${DEAD_KEY_ID}`;
    writeFileSync(authorizedKeys(sshds[0] as Sshd), `${FOREIGN}\n${stale}\n`);
    // The proof signs in with a private key that does not match the line.
    state.tables.ssh_keys[0] = {
      ...(state.tables.ssh_keys[0] as Row),
      privateKey: parseableKeyPair().private,
    };
    expect(await moveServerToKey(IDS[0] as string, USER_ID)).toEqual({
      ok: false,
      code: "keyLoginFailed",
    });
    expect(fileOf(0)).toBe(`${FOREIGN}\n${stale}\n`);
  });

  it("a move whose key stops being current before it commits is undone", async () => {
    // A rotation demotes the key while the move proves it.
    (sshds[0] as Sshd).onKeyAuth = () => {
      (sshds[0] as Sshd).onKeyAuth = null;
      (state.tables.ssh_keys[0] as Row).status = "previous";
      state.tables.ssh_keys.push({
        id: "0197f3a0-1b2c-7def-8000-0000000000bb",
        publicKey: parseableKeyPair().public,
        privateKey: "",
        fingerprint: "SHA256:new",
        status: "current",
      });
    };
    expect(await moveServerToKey(IDS[0] as string, USER_ID)).toEqual({
      ok: false,
      code: "keyJobRunning",
    });
    expect(serverById(0)).toMatchObject({ auth: "password", password: "pw" });
    expect(fileOf(0)).not.toContain(OLD_MARKER);
  });

  it("retireKey leaves a key that a server still uses", async () => {
    (state.tables.ssh_keys[0] as Row).status = "previous";
    state.tables.servers[0] = serverRow(0, {
      auth: "key",
      password: null,
      sshKeyId: OLD_KEY_ID,
    });
    await retireKey(OLD_KEY_ID);
    expect(keyRow("previous")?.id).toBe(OLD_KEY_ID);
    state.tables.servers[0] = serverRow(0);
    await retireKey(OLD_KEY_ID);
    expect(keyRow("previous")).toBeUndefined();
  });

  it("retires the old key at once when every server succeeds", async () => {
    seedKeyServers();
    await request("POST", "/api/instance/ssh-key/rotate");
    await runQueued();
    expect(lastJob().results.map((r: Row) => r.ok)).toEqual([true, true, true]);
    expect(state.tables.ssh_keys.find((k) => k.id === OLD_KEY_ID)?.status).toBe(
      "retired"
    );
  });

  it("a server that cannot be reached keeps its old line", async () => {
    seedKeyServers();
    state.ports[IDS[2] as string] = 1; // nothing listens there
    await request("POST", "/api/instance/ssh-key/rotate");
    await runQueued();
    expect(lastJob().results[2]).toEqual({
      serverId: IDS[2],
      name: "web-3",
      ok: false,
      code: "unreachable",
    });
    expect(fileOf(2)).toBe(`${FOREIGN}\n${oldLine}\n`);
    expect(keyRow("previous")?.id).toBe(OLD_KEY_ID);
  });

  it("skips a server another key operation holds", async () => {
    seedKeyServers();
    const release = await serverKeyLock(IDS[0] as string);
    await request("POST", "/api/instance/ssh-key/rotate");
    await runQueued();
    await release?.();
    expect(lastJob().results[0]).toMatchObject({
      ok: false,
      code: "keyJobRunning",
    });
    expect(fileOf(0)).toBe(`${FOREIGN}\n${oldLine}\n`);
  });
});

describe("rows sharing one host and login", () => {
  // Two rows for one machine and login (one by IP, one by name, say): one
  // authorized_keys, reached through web-1's sshd.
  function twoRowsOneLogin() {
    seedKeyServers();
    state.tables.servers = [
      serverById(0),
      { ...serverById(1), host: (sshds[0] as Sshd).host },
    ];
    state.ports[IDS[1] as string] = (sshds[0] as Sshd).port;
  }

  it("rotating one keeps the line the other still signs in with", async () => {
    twoRowsOneLogin();
    const { current, previous } = await beginRotation();
    expect(
      await rotateServerKey(IDS[0] as string, USER_ID, current, previous.id)
    ).toEqual({ ok: true });
    expect(fileOf(0)).toContain(oldLine);
    expect(fileOf(0)).toContain(markerOf(current.id));

    // The other row still signs in with the old key, and rotates in turn;
    // then no row names the old key and its line goes.
    expect(
      await rotateServerKey(IDS[1] as string, USER_ID, current, previous.id)
    ).toEqual({ ok: true });
    expect(serverById(1)).toMatchObject({ sshKeyId: current.id });
    expect(fileOf(0)).not.toContain(OLD_MARKER);
    expect(fileOf(0)).toContain(FOREIGN);
  });

  it("moving a password row keeps the line of a key row on the same login", async () => {
    twoRowsOneLogin();
    Object.assign(serverById(1), {
      auth: "password",
      password: "pw",
      sshKeyId: null,
    });
    const { current } = await beginRotation();
    expect(await moveServerToKey(IDS[1] as string, USER_ID)).toEqual({
      ok: true,
    });
    expect(fileOf(0)).toContain(oldLine);
    expect(fileOf(0)).toContain(markerOf(current.id));
  });

  it("a row on another login of the same host does not keep a line", async () => {
    twoRowsOneLogin();
    Object.assign(serverById(1), { username: "deploy" });
    const { current, previous } = await beginRotation();
    expect(
      await rotateServerKey(IDS[0] as string, USER_ID, current, previous.id)
    ).toEqual({ ok: true });
    expect(fileOf(0)).not.toContain(OLD_MARKER);
  });
});

describe("one key job at a time", () => {
  it("second job refused", async () => {
    expect(
      (await request("POST", "/api/instance/ssh-key/move-all")).status
    ).toBe(202);
    // Queued, not started yet: both kinds are refused.
    for (const path of ["move-all", "rotate"]) {
      const res = await request("POST", `/api/instance/ssh-key/${path}`);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("keyJobRunning");
    }
    // Running (the worker holds the lock): still refused.
    const release = await keyJobLock();
    state.tables.ssh_key_jobs[0] = {
      ...lastJob(),
      startedAt: new Date(),
    };
    state.queued.clear();
    const res = await request("POST", "/api/instance/ssh-key/rotate");
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("keyJobRunning");
    await release?.();
    expect(state.enqueued).toHaveLength(1);
    expect(state.tables.ssh_key_jobs).toHaveLength(1);
  });

  it("closes a job whose worker died, then accepts the next", async () => {
    await request("POST", "/api/instance/ssh-key/move-all");
    // Started, but no process holds the lock any more.
    Object.assign(lastJob(), { startedAt: new Date() });
    const dead = lastJob().id;

    expect((await request("POST", "/api/instance/ssh-key/rotate")).status).toBe(
      202
    );
    expect(state.tables.ssh_key_jobs.find((j) => j.id === dead)).toMatchObject({
      errorCode: "keyJobInterrupted",
    });
    expect(lastJob()).toMatchObject({ kind: "rotate", finishedAt: null });

    // The dead job, picked up late by the queue, does nothing.
    expect(
      await processJob({
        name: "server-key-move-all",
        data: { keyJobId: dead },
      } as never)
    ).toEqual({ status: "skipped" });
  });

  it("closes a queued job the queue lost", async () => {
    await request("POST", "/api/instance/ssh-key/move-all");
    state.queued.clear();
    expect(
      (await request("POST", "/api/instance/ssh-key/move-all")).status
    ).toBe(202);
    expect(state.tables.ssh_key_jobs[0]).toMatchObject({
      errorCode: "keyJobInterrupted",
    });
  });

  it("a duplicate delivery that finds the job lock taken leaves the row alone", async () => {
    await request("POST", "/api/instance/ssh-key/move-all");
    Object.assign(lastJob(), { startedAt: new Date("2026-11-09T01:00:00Z") });
    const before = structuredClone(lastJob());
    const release = await keyJobLock();
    expect(await runQueued()).toEqual({ status: "keyJobRunning" });
    await release?.();
    expect(lastJob()).toEqual(before);
    expect(serverById(0)).toMatchObject({ auth: "password" });
  });

  it("a redelivered job keeps the results already recorded", async () => {
    // The first delivery moved web-1, then its worker died.
    state.tables.servers[0] = serverRow(0, { auth: "key", password: null });
    await request("POST", "/api/instance/ssh-key/move-all");
    const first = { serverId: IDS[0], name: "web-1", ok: true, code: null };
    Object.assign(lastJob(), { startedAt: new Date(), results: [first] });
    await runQueued();
    expect(lastJob().results).toEqual([
      first,
      { serverId: IDS[1], name: "web-2", ok: true, code: null },
      { serverId: IDS[2], name: "web-3", ok: true, code: null },
    ]);
  });

  it("GET closes an abandoned job", async () => {
    await request("POST", "/api/instance/ssh-key/move-all");
    Object.assign(lastJob(), { startedAt: new Date() });
    const got = await (await request("GET", "/api/instance/ssh-key")).json();
    expect(got.lastJob).toMatchObject({ errorCode: "keyJobInterrupted" });
    expect(got.lastJob.finishedAt).not.toBeNull();
  });

  it("the running-job check only sees this database's locks", async () => {
    await request("POST", "/api/instance/ssh-key/move-all");
    Object.assign(lastJob(), { startedAt: new Date() });
    await request("GET", "/api/instance/ssh-key");
    const check = state.rawQueries.find((q) => q.includes("pg_locks"));
    expect(check).toMatch(
      /database = \(\s*select oid from pg_database where datname = current_database\(\)\s*\)/
    );
  });

  it("the job lock does not block a server's key lock, and only one job holds it", async () => {
    const release = await keyJobLock();
    expect(release).not.toBeNull();
    expect(await keyJobLock()).toBeNull();
    const server = await serverKeyLock(IDS[0] as string);
    expect(server).not.toBeNull();
    await server?.();
    await release?.();
  });

  it("host keys pinned by a job are recorded for system and the job", async () => {
    state.tables.servers = [
      serverRow(0, {
        hostKeyType: null,
        hostKey: null,
        hostKeyFingerprint: null,
        hostKeyPinnedAt: null,
      }),
    ];
    await request("POST", "/api/instance/ssh-key/move-all");
    await runQueued();
    const keyJobId = lastJob().id;
    expect(state.activity).toContainEqual(
      expect.objectContaining({
        action: "server.hostKeyPinned",
        actorId: null,
        data: expect.objectContaining({ job: keyJobId }),
      })
    );
    expect(state.activity).toContainEqual(
      expect.objectContaining({
        action: "server.keyInstalled",
        actorId: USER_ID,
      })
    );
  });
});

describe("routes", () => {
  it("need org server:manage, not instance:manage", async () => {
    // infra manages servers but not the instance.
    state.orgRole = "infra";
    expect((await request("GET", "/api/instance/ssh-key")).status).toBe(200);
    expect(
      (await request("POST", "/api/instance/ssh-key/move-all")).status
    ).toBe(202);
    // The rest of /api/instance stays instance:manage.
    expect((await request("GET", "/api/instance/backups")).status).toBe(403);

    state.orgRole = "observer";
    for (const [method, path] of [
      ["GET", ""],
      ["POST", "/move-all"],
      ["POST", "/rotate"],
    ] as const) {
      const res = await request(method, `/api/instance/ssh-key${path}`);
      expect(res.status).toBe(403);
    }
    expect(state.tables.ssh_key_jobs).toHaveLength(1);
  });

  it("GET with no job yet", async () => {
    expect(
      await (await request("GET", "/api/instance/ssh-key")).json()
    ).toEqual({
      publicKey: oldKey.public,
      fingerprint: "SHA256:old",
      lastJob: null,
    });
  });
});

describe("serverKeyLock connection", () => {
  // A lock connection the test drives: what it was asked, whether it was
  // ended, and the close callback lockConnection was given.
  function fakeLockConnection(
    answer: (text: string) => Promise<unknown> = async () => [{ locked: true }]
  ) {
    const conn = {
      queries: [] as string[],
      ends: 0,
      onclose: () => {},
    };
    state.lockConnection = (onclose) => {
      conn.onclose = onclose;
      return Object.assign(
        async (strings: TemplateStringsArray) => {
          const text = strings.join("?");
          conn.queries.push(text);
          return text.includes("pg_try_advisory_lock")
            ? [{ locked: true }]
            : answer(text);
        },
        {
          end: async () => {
            conn.ends += 1;
          },
        }
      );
    };
    return conn;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends the connection after a clean unlock", async () => {
    const conn = fakeLockConnection(async () => []);
    const unlock = await serverKeyLock(IDS[0] as string);
    await unlock?.();
    expect(conn.queries.at(-1)).toContain("pg_advisory_unlock");
    expect(conn.ends).toBe(1);
  });

  it("after a failed unlock, ends the connection and sends nothing more", async () => {
    const conn = fakeLockConnection(async () => {
      throw new Error("write CONNECTION_CLOSED");
    });
    const unlock = await serverKeyLock(IDS[0] as string);
    await expect(unlock?.()).rejects.toThrow("CONNECTION_CLOSED");
    expect(conn.queries).toHaveLength(2);
    expect(conn.queries.at(-1)).toContain("pg_advisory_unlock");
    expect(conn.ends).toBe(1);
  });

  it("a connection that closed while held is released without a query", async () => {
    const conn = fakeLockConnection(async () => {
      throw new Error("must not be sent");
    });
    const unlock = await serverKeyLock(IDS[0] as string);
    conn.onclose();
    await unlock?.();
    expect(conn.queries).toHaveLength(1);
    expect(conn.ends).toBe(1);
  });

  it("an unlock that never answers is cut off and the connection ended", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const conn = fakeLockConnection(() => new Promise(() => {}));
    const unlock = await serverKeyLock(IDS[0] as string);
    const released = unlock?.();
    const outcome = expect(released).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(5_000);
    await outcome;
    expect(conn.ends).toBe(1);
  });

  it("a lock whose take fails ends its connection", async () => {
    const conn = { ends: 0 };
    state.lockConnection = () =>
      Object.assign(
        async () => {
          throw new Error("connection refused");
        },
        {
          end: async () => {
            conn.ends += 1;
          },
        }
      );
    await expect(serverKeyLock(IDS[0] as string)).rejects.toThrow(
      "connection refused"
    );
    expect(conn.ends).toBe(1);
    // Its session slot was given back.
    state.lockConnection = null;
    const releases = await Promise.all(
      [0, 1, 2, 3].map((i) => serverKeyLock(`server-${i}`))
    );
    expect(releases.every((r) => r !== null)).toBe(true);
    for (const r of releases) await r?.();
  });

  it("at most four lock sessions: a fifth waits a bounded time, then is refused", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const held = await Promise.all(
      [0, 1, 2, 3].map((i) => serverKeyLock(`server-${i}`))
    );
    expect(held.every((r) => r !== null)).toBe(true);
    let fifth: unknown = "pending";
    const waiting = serverKeyLock("server-4").then((r) => {
      fifth = r;
      return r;
    });
    await vi.advanceTimersByTimeAsync(4_900);
    expect(fifth).toBe("pending");
    await vi.advanceTimersByTimeAsync(100);
    expect(await waiting).toBeNull();
    // A key operation refused this way answers keyJobRunning.
    const move = moveServerToKey(IDS[0] as string, USER_ID);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await move).toEqual({ ok: false, code: "keyJobRunning" });
    for (const r of held) await r?.();
  });

  it("a waiting lock gets the session a release frees", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const held = await Promise.all(
      [0, 1, 2, 3].map((i) => serverKeyLock(`server-${i}`))
    );
    const waiting = serverKeyLock("server-4");
    await vi.advanceTimersByTimeAsync(1_000);
    await held[0]?.();
    const fifth = await waiting;
    expect(fifth).not.toBeNull();
    await fifth?.();
    for (const r of held.slice(1)) await r?.();
  });
});
