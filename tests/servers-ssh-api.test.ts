import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { locales } from "@/i18n/locales";

// What the servers API hands the browser about SSH access, the new-server
// key mode and the "install the key yourself" line. The database is a fake
// that answers every select with `state.rows` and records inserts.

const KEY_ID = "0197f3a0-1b2c-7def-8000-0000000000cc";
const SERVER_ID = "0197f3a0-1b2c-7def-8000-000000000001";
const PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOmUu3eLe3b0Yj2a1t5qWJp3m2p0aQm8v1y3c4m3dXaL";

const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  inserted: [] as Record<string, unknown>[],
  role: "admin",
  tested: [] as unknown[],
}));

vi.mock("@/lib/db", () => {
  const query = () => {
    const q: Record<string, unknown> = {};
    q.from = () => q;
    q.where = () => q;
    q.orderBy = async () => state.rows;
    q.limit = async () => state.rows.slice(0, 1);
    return q;
  };
  return {
    db: {
      select: () => query(),
      insert: () => ({
        values: (values: Record<string, unknown>) => ({
          returning: async () => {
            state.inserted.push(values);
            return [{ ...row(), ...values }];
          },
        }),
      }),
    },
    pgClient: vi.fn(),
  };
});
vi.mock("@/lib/secrets", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  encryptSecret: (value: string) => `enc:${value}`,
  decryptNullable: (value: string | null) => value,
}));
vi.mock("@/lib/ssh-keys", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ensureCurrentKey: async () => ({
    id: KEY_ID,
    publicKey: PUBLIC_KEY,
    fingerprint: "SHA256:instance",
  }),
}));
vi.mock("@/lib/ssh", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  testSshConnection: vi.fn(async (target: unknown) => {
    state.tested.push(target);
    return { ok: true };
  }),
}));
vi.mock("@/lib/explorer", async (importOriginal) => {
  const { HostKeyMismatchError } = await import("@/lib/ssh-connect");
  return {
    ...(await importOriginal<object>()),
    resolveBackend: async () => ({
      list: async () => {
        throw new HostKeyMismatchError("SHA256:offered", "SHA256:pinned");
      },
    }),
  };
});
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));
vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({
    user: { id: "0197f3a0-1b2c-7def-8000-0123456789b1", role: state.role },
  })),
}));
vi.mock("@/server/i18n", () => ({
  getServerTranslator: async () => (key: string) => key,
}));

const { app } = await import("@/server/app");

function row(extra: Record<string, unknown> = {}) {
  return {
    id: SERVER_ID,
    name: "web-1",
    host: "192.0.2.10",
    username: "root",
    auth: "key",
    password: "enc:hunter2",
    hostKeyType: "ssh-ed25519",
    hostKey: "AAAApinnedblob",
    hostKeyFingerprint: "SHA256:pinned",
    hostKeyPinnedAt: new Date("2026-11-09T10:00:00Z"),
    hostKeyOfferedType: "ssh-ed25519",
    hostKeyOffered: "AAAAofferedblob",
    hostKeyOfferedFingerprint: "SHA256:offered",
    sshKeyId: KEY_ID,
    sshFrom: "172.29.0.0/16",
    keyError: "hostKeyMismatch",
    sftpRoot: "/",
    placement: "restricted",
    preflight: null,
    preflightAt: null,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-09T10:00:00Z"),
    ...extra,
  };
}

const get = (path: string) => app.request(path);
const post = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const SECRET_FIELDS = [
  "password",
  "hostKey",
  "hostKeyType",
  "hostKeyOffered",
  "hostKeyOfferedType",
  "privateKey",
];

beforeEach(() => {
  state.rows = [row()];
  state.inserted = [];
  state.tested = [];
  state.role = "admin";
  delete process.env.COMPOSE_PROJECT_NAME;
});

describe("server rows sent to the browser", () => {
  it("the list has the access fields and no password, key or host key blob", async () => {
    const res = await get("/api/servers/get-servers");
    expect(res.status).toBe(200);
    const [server] = await res.json();
    for (const field of SECRET_FIELDS) expect(server).not.toHaveProperty(field);
    const text = JSON.stringify(server);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("blob");
    expect(server).toMatchObject({
      auth: "key",
      hostKeyFingerprint: "SHA256:pinned",
      hostKeyPinnedAt: "2026-11-09T10:00:00.000Z",
      hostKeyMismatch: true,
      offeredFingerprint: "SHA256:offered",
      sshFrom: "172.29.0.0/16",
      keyError: "hostKeyMismatch",
      hasPassword: true,
      keyMarker: `opsdeck:opsdeck:${KEY_ID}`,
    });
  });

  it("a server with no offered key is no mismatch and a password server has no marker", async () => {
    state.rows = [
      row({
        auth: "password",
        password: null,
        sshKeyId: null,
        hostKeyOfferedType: null,
        hostKeyOffered: null,
        hostKeyOfferedFingerprint: null,
      }),
    ];
    const server = await (
      await get(`/api/servers/get-server-by-id?id=${SERVER_ID}`)
    ).json();
    for (const field of SECRET_FIELDS) expect(server).not.toHaveProperty(field);
    expect(server).toMatchObject({
      auth: "password",
      hostKeyMismatch: false,
      offeredFingerprint: null,
      hasPassword: false,
      keyMarker: null,
    });
  });
});

const BASE = {
  name: "web-2",
  host: "192.0.2.11",
  username: "root",
  sftpRoot: "/",
  placement: "restricted",
};

describe("creating a server", () => {
  it("in key mode stores no password and signs in with the current key", async () => {
    const res = await post("/api/servers/create-server", {
      data: { ...BASE, auth: "key", sshFrom: "192.0.2.1" },
    });
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(state.inserted[0]).toMatchObject({
      auth: "key",
      password: null,
      sshKeyId: KEY_ID,
      sshFrom: "192.0.2.1",
    });
    expect(body.data).not.toHaveProperty("password");
  });

  it("in key mode refuses a password or an invalid from", async () => {
    for (const data of [
      { ...BASE, auth: "key", sshFrom: "192.0.2.1", password: "x" },
      { ...BASE, auth: "key", sshFrom: '1.2.3.4",command="id' },
      { ...BASE, auth: "key" },
    ]) {
      const body = await (
        await post("/api/servers/create-server", { data })
      ).json();
      expect(body.success).toBe(false);
    }
    expect(state.inserted).toHaveLength(0);
  });

  it("without a password (the password is typed once afterwards) stores none", async () => {
    const body = await (
      await post("/api/servers/create-server", { data: BASE })
    ).json();
    expect(body.success).toBe(true);
    expect(state.inserted[0]).toMatchObject({
      auth: "password",
      password: null,
    });
  });

  it("an edit cannot switch a server to the key", async () => {
    const { serverUpdateSchema } = await import("@/lib/validation");
    expect(
      serverUpdateSchema.parse({ auth: "key", sshFrom: "192.0.2.1" })
    ).toEqual({});
  });

  it("tests an unsaved server with the key", async () => {
    const body = await (
      await post("/api/servers/test-server-connection", {
        input: { host: "192.0.2.11", username: "root", auth: "key" },
      })
    ).json();
    expect(body.ok).toBe(true);
    expect(state.tested[0]).toMatchObject({
      serverId: null,
      auth: "key",
      password: null,
    });
  });
});

describe("GET /api/instance/ssh-key/authorized-line", () => {
  it("returns the authorized_keys line and a command that installs it", async () => {
    const res = await get(
      "/api/instance/ssh-key/authorized-line?from=192.0.2.1"
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const line = `from="192.0.2.1",no-agent-forwarding,no-X11-forwarding ${PUBLIC_KEY} opsdeck:opsdeck:${KEY_ID}`;
    expect(body.line).toBe(line);
    expect(body.command).toContain(`'${line}'`);
    expect(body.command).toContain("chmod 700 ~/.ssh");
    expect(body.command).toContain(">> ~/.ssh/authorized_keys");
    expect(body.command).toContain("chmod 600 ~/.ssh/authorized_keys");
    expect(JSON.stringify(body)).not.toContain("PRIVATE");
  });

  it("accepts a subnet and refuses anything that is not an address", async () => {
    expect(
      (await get("/api/instance/ssh-key/authorized-line?from=172.29.0.0%2F16"))
        .status
    ).toBe(200);
    const bad = await get(
      `/api/instance/ssh-key/authorized-line?from=${encodeURIComponent('1.2.3.4",command="id')}`
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe("invalidFrom");
  });

  it("needs server:manage", async () => {
    state.role = "observer";
    const res = await get(
      "/api/instance/ssh-key/authorized-line?from=192.0.2.1"
    );
    expect(res.status).toBe(403);
  });
});

describe("a changed host key in the file explorer", () => {
  it("is answered with its code and message, not a generic failure", async () => {
    const { listEntries } = await import("@/server/services/explorer");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await listEntries({ kind: "sftp", serverId: SERVER_ID }, "");
    expect(result).toEqual({
      success: false,
      code: "hostKeyMismatch",
      message: "hostKeyMismatch",
    });
  });
});

describe("activity labels for SSH key events", () => {
  // Every server.* kind the backend records about keys and host keys.
  const sources = ["lib/ssh-connect.ts", "server/services/server-keys.ts"].map(
    (file) => readFileSync(file, "utf8")
  );
  const kinds = [
    ...new Set(
      sources.flatMap((source) =>
        [...source.matchAll(/"(server\.(?:hostKey|key)[A-Za-z]+)"/g)].map(
          (m) => m[1] ?? ""
        )
      )
    ),
  ];
  const page = readFileSync(
    "web/routes/$locale/_app/admin.activity.tsx",
    "utf8"
  );

  it("finds the kinds", () => {
    expect(kinds).toEqual(
      expect.arrayContaining([
        "server.hostKeyPinned",
        "server.hostKeyMismatch",
        "server.hostKeyTrusted",
        "server.keyInstalled",
        "server.keyReinstalled",
        "server.keyRotated",
      ])
    );
  });

  it("the activity page renders each one, in every locale", () => {
    for (const kind of kinds) {
      const at = page.indexOf(`case "${kind}":`);
      expect(at, kind).toBeGreaterThan(-1);
      const key = /t\("([A-Za-z]+)"/.exec(page.slice(at))?.[1] ?? "";
      for (const locale of locales) {
        const activity = JSON.parse(
          readFileSync(`messages/${locale}.json`, "utf8")
        ).activity;
        expect(activity[key], `${locale} ${key}`).toContain("{server}");
      }
    }
  });
});
