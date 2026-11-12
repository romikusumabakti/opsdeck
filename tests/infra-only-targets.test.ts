import { beforeEach, describe, expect, it, vi } from "vitest";

// Restricted targets (lib/restricted-targets): the engineer grant opens the
// terminal and the file explorer fleet-wide, but not on an infra-only server
// or the instance backup bucket. The database is a fake that answers by table.

const NORMAL_ID = "0197f3a0-1b2c-7def-8000-000000000001";
const INFRA_ID = "0197f3a0-1b2c-7def-8000-000000000002";
const BUCKET_ID = "0197f3a0-1b2c-7def-8000-0000000000b1";
const BACKUP_BUCKET_ID = "0197f3a0-1b2c-7def-8000-0000000000b2";

const state = vi.hoisted(() => ({
  session: { user: { id: "u1", role: "member" } },
  memberships: [] as { projectId: string; role: string }[],
  backupId: null as string | null,
  activity: [] as Record<string, unknown>[],
}));

function serverRow(id: string, infraOnly: boolean) {
  return {
    id,
    name: infraOnly ? "panel-host" : "web-1",
    host: "192.0.2.10",
    username: "root",
    sftpRoot: "/",
    infraOnly,
  };
}

vi.mock("@/lib/db", async () => {
  const schema = await import("@/lib/db/schema");
  // A thenable over `rows`: awaited directly, or after where()/limit().
  const answer = (rows: () => unknown[]) => {
    const q: Record<string, unknown> = {};
    const self = () => Object.assign(Promise.resolve(rows()), q);
    q.where = (condition: unknown) => {
      lastWhere = condition;
      return self();
    };
    q.limit = async () => rows().slice(0, 1);
    q.orderBy = async () => rows();
    return self();
  };
  let lastWhere: unknown;
  // The id a where(eq(column, id)) compares against: the uuid string in
  // drizzle's SQL chunks (the tree is cyclic, so walk it with a seen set).
  const whereId = () => {
    const seen = new Set<unknown>();
    const walk = (node: unknown): string | undefined => {
      if (typeof node === "string") {
        return /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(node) ? node : undefined;
      }
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      for (const value of Object.values(node)) {
        const found = walk(value);
        if (found) return found;
      }
    };
    return walk(lastWhere);
  };
  return {
    db: {
      select: () => ({
        from: (table: unknown) => {
          if (table === schema.projects) return answer(() => [{ id: "p1" }]);
          if (table === schema.projectMembers) {
            return answer(() => state.memberships);
          }
          if (table === schema.instanceSettings) {
            return answer(() => [{ id: state.backupId }]);
          }
          if (table === schema.servers) {
            return answer(() => {
              const id = whereId();
              if (id === NORMAL_ID) return [serverRow(NORMAL_ID, false)];
              if (id === INFRA_ID) return [serverRow(INFRA_ID, true)];
              return [];
            });
          }
          throw new Error("unexpected table");
        },
      }),
    },
    pgClient: vi.fn(),
  };
});
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));
vi.mock("@/lib/auth-session", () => ({
  requireSession: async () => state.session,
  getServerSession: async () => state.session,
}));
vi.mock("@/lib/activity", () => ({
  recordActivity: vi.fn(async (entry: Record<string, unknown>) => {
    state.activity.push(entry);
  }),
}));
vi.mock("@/lib/terminal/protocol", () => ({
  mintTicket: () => "signed-ticket",
}));
const resolved = vi.hoisted(() => ({ sources: [] as unknown[] }));
vi.mock("@/lib/explorer", () => ({
  resolveBackend: async (source: unknown) => {
    resolved.sources.push(source);
    return { list: async () => [] };
  },
}));
vi.mock("@/server/i18n", () => ({
  getServerTranslator: async () => (key: string) => key,
}));

const { app } = await import("@/server/app");
const { ForbiddenError } = await import("@/lib/authz");
const { listEntries } = await import("@/server/services/explorer");

function as(role: string, ...projectRoles: string[]) {
  state.session = { user: { id: "u1", role } };
  state.memberships = projectRoles.map((r, i) => ({
    projectId: `p${i + 1}`,
    role: r,
  }));
}

const ticket = (serverId: string) =>
  app.request("/api/terminal/ticket", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId }),
  });

const download = (source: unknown) =>
  app.request(
    `/api/explorer/download?source=${encodeURIComponent(JSON.stringify(source))}&path=a.txt`
  );

beforeEach(() => {
  state.backupId = BACKUP_BUCKET_ID;
  state.activity = [];
  resolved.sources = [];
});

describe("terminal ticket on an infra-only server", () => {
  it("refuses an engineer member and records the denial", async () => {
    as("member", "engineer");
    const res = await ticket(INFRA_ID);
    expect(res.status).toBe(403);
    expect(state.activity).toEqual([
      expect.objectContaining({
        action: "terminal.denied",
        entityId: INFRA_ID,
        data: { server: "panel-host", reason: "infraOnly" },
      }),
    ]);
  });

  it("still mints one for an engineer member on a normal server", async () => {
    as("member", "engineer");
    const res = await ticket(NORMAL_ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ticket: "signed-ticket" });
  });

  it("mints one for infra", async () => {
    as("infra");
    const res = await ticket(INFRA_ID);
    expect(res.status).toBe(200);
    expect(state.activity).toEqual([]);
  });
});

describe("file explorer on restricted targets", () => {
  it("denies an engineer member an infra-only server before any backend", async () => {
    as("member", "engineer");
    await expect(
      listEntries({ kind: "sftp", serverId: INFRA_ID }, "")
    ).rejects.toBeInstanceOf(ForbiddenError);
    const res = await download({ kind: "sftp", serverId: INFRA_ID });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(resolved.sources).toEqual([]);
  });

  it("denies an engineer member the instance backup bucket", async () => {
    as("member", "engineer");
    await expect(
      listEntries({ kind: "s3", connectionId: BACKUP_BUCKET_ID }, "")
    ).rejects.toBeInstanceOf(ForbiddenError);
    const res = await app.request(
      `/api/explorer/archive?source=${encodeURIComponent(
        JSON.stringify({ kind: "s3", connectionId: BACKUP_BUCKET_ID })
      )}`
    );
    expect(res.status).toBe(403);
    expect(resolved.sources).toEqual([]);
  });

  it("allows an engineer member normal servers and buckets", async () => {
    as("member", "engineer");
    expect(
      await listEntries({ kind: "sftp", serverId: NORMAL_ID }, "")
    ).toEqual({ success: true, data: [] });
    expect(
      await listEntries({ kind: "s3", connectionId: BUCKET_ID }, "")
    ).toEqual({ success: true, data: [] });
  });

  it("allows infra on both restricted targets", async () => {
    as("infra");
    expect(await listEntries({ kind: "sftp", serverId: INFRA_ID }, "")).toEqual(
      { success: true, data: [] }
    );
    expect(
      await listEntries({ kind: "s3", connectionId: BACKUP_BUCKET_ID }, "")
    ).toEqual({ success: true, data: [] });
  });

  it("treats no backup destination as no restricted bucket", async () => {
    as("member", "engineer");
    state.backupId = null;
    expect(
      await listEntries({ kind: "s3", connectionId: BACKUP_BUCKET_ID }, "")
    ).toEqual({ success: true, data: [] });
  });

  it("still refuses a member without the grant by the central guard", async () => {
    as("member", "qa");
    await expect(
      listEntries({ kind: "sftp", serverId: NORMAL_ID }, "")
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
