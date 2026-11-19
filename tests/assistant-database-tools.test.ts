import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantViewer } from "@/lib/assistant/viewer";
import type { EnvironmentListItem } from "@/lib/db/schema";

// The Assistant's database tools (Stage 9 spec F.3): who may call them, the
// enable hint on an environment without access, the row/cell/byte caps,
// masking, and the activity entry with literals replaced by `?`. The
// engine commands and output parsers are in tests/assistant-db-query.test.ts,
// the gate in tests/assistant-db-gate.test.ts.

const fakes = vi.hoisted(() => ({
  login: null as null | Record<string, unknown>,
  result: { columns: [] as string[], rows: [] as (string | null)[][] },
  error: null as Error | null,
  runs: [] as { environmentId: string; sql: string; rowLimit: number }[],
  activity: [] as Record<string, unknown>[],
  getLogin: vi.fn(),
}));

vi.mock("@/lib/assistant-db/login", () => ({
  getAssistantDbLogin: fakes.getLogin,
}));
vi.mock("@/lib/assistant-db/query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assistant-db/query")>()),
  runAssistantDbQuery: vi.fn(
    async (
      environmentId: string,
      _login: unknown,
      sql: string,
      rowLimit: number
    ) => {
      fakes.runs.push({ environmentId, sql, rowLimit });
      if (fakes.error) throw fakes.error;
      return fakes.result;
    }
  ),
}));
vi.mock("@/lib/activity", () => ({
  recordActivity: vi.fn(async (entry: Record<string, unknown>) => {
    fakes.activity.push(entry);
  }),
}));
vi.mock("@/lib/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/environments")>()),
  environmentName: vi.fn(async () => "Acme Membership / QA"),
}));

const { buildTools, executeTool } = await import("@/lib/assistant/tool-defs");
const { createPanelTurn } = await import("@/lib/assistant/tools/panel");
const { AssistantDbQueryError } = await import("@/lib/assistant-db/query");
const { MASK } = await import("@/lib/assistant-db/mask");
const { MAX_QUERY_ROWS, MAX_CELL_CHARS } = await import(
  "@/lib/assistant/tools/database"
);

const ACME_ID = "01900000-0000-7000-8000-000000000001";
const ENV_ID = "01900000-0000-7000-8000-000000001001";

const ENV = {
  id: ENV_ID,
  projectId: ACME_ID,
  name: "QA",
  slug: "qa",
  kind: "qa",
  ownerId: null,
  url: null,
  key: "ACME",
  serviceRoles: ["backend", "db"],
} as unknown as EnvironmentListItem;

const viewerAs = (
  orgRole: AssistantViewer["orgRole"],
  projectRole: "engineer" | "qa" = orgRole === "engineer" ||
  orgRole === "admin" ||
  orgRole === "infra"
    ? "engineer"
    : "qa"
): AssistantViewer => ({
  userId: "u1",
  orgRole,
  projectIds: [ACME_ID],
  canManageKnowledge: false,
  scope: {
    userId: "u1",
    orgRole,
    projectRoles: { [ACME_ID]: projectRole },
    seesAllProjects: false,
  },
});

function ctxFor(viewer: AssistantViewer, envs: EnvironmentListItem[] = [ENV]) {
  return {
    mode: "auto" as const,
    viewer,
    attachments: [],
    uploads: [],
    nativeFiles: true,
    panel: createPanelTurn(viewer, {
      projects: async () => [],
      cores: {
        listEnvironments: vi.fn(async () => envs),
        resolveEnvironmentSlug: vi.fn(async () => null),
      },
    }),
    snapshotsFor: async () => [],
    listProjects: async () => [],
  };
}

const POSTGRES_LOGIN = {
  engine: "postgres",
  serviceId: "svc-1",
  login: "menara_ro_acme_qa",
  database: "acme_qa",
};

const query = (sql: string, viewer = viewerAs("engineer")) =>
  executeTool(
    "query_database",
    { environment: "ACME/qa", sql },
    ctxFor(viewer)
  );

beforeEach(() => {
  fakes.login = POSTGRES_LOGIN;
  fakes.result = { columns: ["id"], rows: [["1"]] };
  fakes.error = null;
  fakes.runs.length = 0;
  fakes.activity.length = 0;
  fakes.getLogin.mockReset();
  fakes.getLogin.mockImplementation(async () => fakes.login);
});

describe("who gets the database tools", () => {
  const names = (viewer: AssistantViewer) =>
    Object.keys(buildTools(ctxFor(viewer), async () => {}));

  it("offers list_tables and query_database to engineer, infra and admin, last", () => {
    for (const role of ["engineer", "infra", "admin"] as const) {
      expect(names(viewerAs(role)).slice(-2), role).toEqual([
        "list_tables",
        "query_database",
      ]);
    }
  });

  it("never offers them to qa, ba, pm, staff or observer", () => {
    for (const role of ["qa", "ba", "pm", "staff", "observer"] as const) {
      const offered = names(viewerAs(role));
      expect(offered, role).not.toContain("list_tables");
      expect(offered, role).not.toContain("query_database");
    }
  });

  it("refuses a QA caller as an unknown tool, without reading the login", async () => {
    for (const name of ["query_database", "list_tables"]) {
      const result = await executeTool(
        name,
        { environment: "ACME/qa", sql: "SELECT 1" },
        ctxFor(viewerAs("qa"))
      );
      expect(result, name).toEqual({
        ok: false,
        error: `unknown tool: ${name}`,
        meta: {},
      });
    }
    expect(fakes.getLogin).not.toHaveBeenCalled();
    expect(fakes.runs).toEqual([]);
    expect(fakes.activity).toEqual([]);
  });

  it("refuses an environment the user can't see as unknown", async () => {
    const result = await executeTool(
      "query_database",
      { environment: "ACME/prod", sql: "SELECT 1" },
      ctxFor(viewerAs("engineer"))
    );
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Unknown environment ACME/prod"),
    });
    expect(fakes.getLogin).not.toHaveBeenCalled();
  });

  it("refuses without the engineer role on the environment's project", async () => {
    const result = await query("SELECT 1", viewerAs("engineer", "qa"));
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("only available to engineers"),
    });
    expect(fakes.getLogin).not.toHaveBeenCalled();
  });
});

describe("query_database", () => {
  it("refuses an environment without access, with the enable hint, and logs it", async () => {
    fakes.login = null;
    const result = await query("SELECT id FROM orders WHERE total > 10");
    expect(result.ok).toBe(false);
    const error = result.ok ? "" : result.error;
    expect(error).toContain("not enabled for ACME/qa");
    expect(error).toContain("admin or infra");
    expect(error).toContain("Settings › Database");
    expect(fakes.runs).toEqual([]);
    expect(fakes.activity).toEqual([
      expect.objectContaining({
        action: "assistant.databaseQuery",
        actorId: "u1",
        entityId: ENV_ID,
        data: expect.objectContaining({
          outcome: "refused",
          reason: "notEnabled",
          sql: "SELECT id FROM orders WHERE total > ?",
        }),
      }),
    ]);
  });

  it("refuses a non-SELECT before anything is sent, and logs the refusal", async () => {
    const result = await query("SELECT 1; DELETE FROM orders");
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^Query refused: /),
      meta: { reason: "multiple" },
    });
    expect(fakes.runs).toEqual([]);
    expect(fakes.activity[0]?.data).toMatchObject({
      outcome: "refused",
      reason: "multiple",
    });
  });

  it("refuses a wrapped sensitive column", async () => {
    const result = await query("SELECT lower(email) FROM members");
    expect(result).toMatchObject({
      ok: false,
      meta: { reason: "wrapped_sensitive" },
    });
    expect(fakes.runs).toEqual([]);
  });

  it("runs the gated text with a cap of 101 rows and returns 100, saying so", async () => {
    fakes.result = {
      columns: ["id", "status"],
      rows: Array.from({ length: 101 }, (_, i) => [String(i), "paid"]),
    };
    const result = await query("SELECT id, status\nFROM orders;");
    expect(fakes.runs).toEqual([
      {
        environmentId: ENV_ID,
        sql: "SELECT id, status FROM orders",
        rowLimit: MAX_QUERY_ROWS + 1,
      },
    ]);
    expect(result.ok).toBe(true);
    const data = (result.ok ? result.data : {}) as {
      rows: unknown[];
      rowCount: number;
      capped?: boolean;
      notes?: string[];
    };
    expect(data.rows).toHaveLength(MAX_QUERY_ROWS);
    expect(data.rowCount).toBe(MAX_QUERY_ROWS);
    expect(data.capped).toBe(true);
    expect(data.notes?.join(" ")).toContain("More rows exist");
    expect(result.meta).toMatchObject({ rows: 100, capped: true });
  });

  it("masks password_hash from SELECT * but not shipment_date", async () => {
    fakes.result = {
      columns: ["id", "password_hash", "shipment_date"],
      rows: [["1", "$2b$12$abcdefghijklmnopqrstuv", "2026-01-02"]],
    };
    const result = await query("SELECT * FROM members");
    const data = (result.ok ? result.data : {}) as {
      rows: unknown[][];
      notes?: string[];
    };
    expect(data.rows).toEqual([["1", MASK, "2026-01-02"]]);
    expect(data.notes?.join(" ")).toContain("Masked as •••: password_hash");
    expect(result.meta).toMatchObject({ masked: 1 });
  });

  it("cuts long cells and redacts credentials in cells", async () => {
    fakes.result = {
      columns: ["note", "config"],
      rows: [
        ["x".repeat(MAX_CELL_CHARS + 50), "password=hunter2-secret-value"],
      ],
    };
    const result = await query("SELECT note, config FROM settings");
    const data = (result.ok ? result.data : {}) as {
      rows: string[][];
      notes?: string[];
    };
    expect(data.rows[0]?.[0]).toHaveLength(MAX_CELL_CHARS + 1);
    expect(data.rows[0]?.[1]).not.toContain("hunter2");
    expect(data.notes?.join(" ")).toMatch(/cut at 500/);
  });

  it("keeps the total under the byte cap with whole rows", async () => {
    fakes.result = {
      columns: ["note"],
      rows: Array.from({ length: 100 }, () => ["y".repeat(MAX_CELL_CHARS)]),
    };
    const result = await query("SELECT note FROM settings");
    const data = (result.ok ? result.data : {}) as {
      rows: unknown[];
      capped?: boolean;
    };
    expect(data.rows.length).toBeLessThan(100);
    expect(JSON.stringify(data.rows).length).toBeLessThanOrEqual(32 * 1024);
    expect(data.capped).toBe(true);
  });

  it("logs the query with literals replaced by ?, the row count and the outcome", async () => {
    fakes.result = { columns: ["id"], rows: [["1"], ["2"]] };
    await query(
      "SELECT id FROM members WHERE nik = '3201234567890001' AND age > 40"
    );
    expect(fakes.activity).toHaveLength(1);
    const entry = fakes.activity[0] as {
      action: string;
      entityType: string;
      data: Record<string, unknown>;
    };
    expect(entry.action).toBe("assistant.databaseQuery");
    expect(entry.entityType).toBe("environment");
    expect(entry.data).toMatchObject({
      environment: "Acme Membership / QA",
      sql: "SELECT id FROM members WHERE nik = ? AND age > ?",
      rows: 2,
      outcome: "ok",
      reason: "",
    });
    expect(typeof entry.data.durationMs).toBe("number");
    expect(JSON.stringify(entry)).not.toContain("3201234567890001");
  });

  it("passes the database's error back and logs a failure", async () => {
    fakes.error = new AssistantDbQueryError(
      'ERROR:  relation "orderz" does not exist'
    );
    const result = await query("SELECT id FROM orderz");
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("relation ? does not exist"),
    });
    expect(fakes.activity[0]?.data).toMatchObject({ outcome: "failed" });
  });

  it("never passes a masked value back through a conversion error (SQL Server Msg 245)", async () => {
    fakes.login = { ...POSTGRES_LOGIN, engine: "mssql", password: "pw" };
    fakes.error = new AssistantDbQueryError(
      "Msg 245, Level 16, State 1, Line 1\nConversion failed when converting the varchar value 'rani@example.invalid' to data type int."
    );
    const result = await query("SELECT id FROM members WHERE email = 1");
    expect(result.ok).toBe(false);
    const error = result.ok ? "" : result.error;
    expect(error).toContain(
      "Conversion failed when converting the varchar value ? to data type int"
    );
    expect(error).not.toContain("rani@example.invalid");
  });

  it("returns a count of a sensitive column as a number", async () => {
    fakes.result = { columns: ["email_count"], rows: [["42"]] };
    const result = await query(
      "SELECT count(DISTINCT email) AS email_count FROM members"
    );
    expect(result).toMatchObject({ ok: true, data: { rows: [["42"]] } });
  });

  it("hides an unexpected failure's text", async () => {
    fakes.error = new Error("ssh: connect to 10.0.0.9 refused");
    const result = await query("SELECT id FROM orders");
    expect(result).toMatchObject({
      ok: false,
      error: "The query could not be run on the database server.",
    });
  });
});

describe("list_tables", () => {
  it("groups columns per table, marks masked ones, and names the engine", async () => {
    fakes.result = {
      columns: ["table_schema", "table_name", "column_name", "data_type"],
      rows: [
        ["public", "members", "id", "integer"],
        ["public", "members", "email", "text"],
        ["public", "orders", "shipment_date", "date"],
      ],
    };
    const result = await executeTool(
      "list_tables",
      { environment: "ACME/qa" },
      ctxFor(viewerAs("infra"))
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        environment: "ACME/qa",
        engine: "PostgreSQL",
        database: "acme_qa",
        tables: [
          {
            name: "public.members",
            columns: ["id integer", "email text (masked)"],
          },
          { name: "public.orders", columns: ["shipment_date date"] },
        ],
      },
    });
    expect(fakes.runs[0]?.sql).toContain("information_schema.columns");
    expect(fakes.activity).toEqual([]);
  });

  it("refuses an environment without access with the enable hint", async () => {
    fakes.login = null;
    const result = await executeTool(
      "list_tables",
      { environment: "ACME/qa" },
      ctxFor(viewerAs("admin"))
    );
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Settings › Database"),
    });
    expect(fakes.runs).toEqual([]);
  });
});
