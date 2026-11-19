import { beforeEach, describe, expect, it, vi } from "vitest";

// How a gated query reaches each engine (Stage 9 spec F.2): as the
// dedicated login only, one non-interactive argument, the row cap and the
// 10 s timeout per engine, the password on stdin only; and the parsers of
// each CLI's machine-readable output (NULLs, separators, line breaks).

type ExecCall = { command: string; stdin?: string };
const ssh = vi.hoisted(() => ({
  calls: [] as ExecCall[],
  results: [] as { code: number; stdout: string; stderr: string }[],
}));

vi.mock("@/lib/ssh-session", () => ({
  openSsh: async () => ({
    async execCommand(command: string, options?: { stdin?: string }) {
      ssh.calls.push({ command, stdin: options?.stdin });
      return ssh.results.shift() ?? { code: 0, stdout: "", stderr: "" };
    },
    dispose() {},
  }),
}));

const SERVICE = {
  id: "svc-1",
  serviceType: "docker" as const,
  serviceName: "acme-db",
  server: {
    id: "srv-1",
    host: "db.example.invalid",
    username: "ops",
    password: "ssh-pass-777",
    auth: "password" as const,
  },
};

vi.mock("@/lib/environments", () => ({
  loadEnvironmentWithServers: vi.fn(async () => ({ services: [SERVICE] })),
}));

const {
  AssistantDbQueryError,
  assistantQueryCommand,
  cappedSql,
  parseMysqlXml,
  parsePsqlCsv,
  parseSqlcmd,
  runAssistantDbQuery,
} = await import("@/lib/assistant-db/query");

const PG = {
  engine: "postgres" as const,
  serviceId: "svc-1",
  login: "menara_ro_acme_qa",
  database: "acme_qa",
};
const MSSQL = {
  engine: "mssql" as const,
  serviceId: "svc-1",
  login: "menara_ro_acme_qa",
  password: "Gen3ratedPassw0rdXyz",
  database: "acme_qa",
};
const MYSQL = { ...MSSQL, engine: "mysql" as const };

const service = SERVICE as unknown as Parameters<
  typeof assistantQueryCommand
>[1];

beforeEach(() => {
  ssh.calls.length = 0;
  ssh.results.length = 0;
});

describe("assistantQueryCommand", () => {
  it("postgres: psql as the read-only role, forced read-only + timeout, row cap, CSV", () => {
    const { command, stdin } = assistantQueryCommand(
      PG,
      service,
      "SELECT id FROM orders",
      101
    );
    expect(stdin).toBeUndefined();
    expect(command).toContain(
      "default_transaction_read_only=on -c statement_timeout=10s"
    );
    expect(command).toContain("PGOPTIONS=");
    expect(command).toContain("-U '\\''menara_ro_acme_qa'\\''");
    expect(command).not.toMatch(/-U '\\''postgres/);
    expect(command).toContain("--csv");
    expect(command).toContain("-X");
    expect(command).toContain(
      "SELECT * FROM (SELECT id FROM orders) AS menara_q LIMIT 101"
    );
  });

  it("mssql: sqlcmd as the login, no variable substitution, -t 10, ROWCOUNT, password on stdin only", () => {
    const { command, stdin } = assistantQueryCommand(
      MSSQL,
      service,
      "SELECT TOP 5 id FROM orders",
      101
    );
    expect(stdin).toBe(`${MSSQL.password}\n`);
    expect(command).not.toContain(MSSQL.password);
    for (const arg of ["-x", "-t", "10", "-W", "-Q", "acme_qa"]) {
      expect(command).toContain(`'\\''${arg}'\\''`);
    }
    expect(command).toContain(
      "SET NOCOUNT ON; SET ROWCOUNT 101; SELECT TOP 5 id FROM orders"
    );
    expect(command).toContain("menara_ro_acme_qa");
  });

  it("mysql: the client as the login, XML output, a session timeout for MySQL or MariaDB and sql_select_limit", () => {
    const { command, stdin } = assistantQueryCommand(
      MYSQL,
      service,
      "SELECT id FROM orders",
      101
    );
    expect(stdin).toBe(`${MYSQL.password}\n`);
    expect(command).not.toContain(MYSQL.password);
    expect(command).toContain("--xml");
    const sql = cappedSql("mysql", "SELECT id FROM orders", 101);
    expect(sql).toContain("max_execution_time = 10000");
    expect(sql).toContain("max_statement_time = 10");
    expect(sql).toContain("SET SESSION sql_select_limit = 101");
    expect(sql.endsWith("; SELECT id FROM orders")).toBe(true);
  });
});

describe("output parsers", () => {
  it("psql CSV: NULL vs empty string, commas, quotes and line breaks in cells", () => {
    const out = 'a,a,n,e,q\n1,2,\u0001,,"x,""y\nz"\n';
    expect(parsePsqlCsv(out)).toEqual({
      columns: ["a", "a", "n", "e", "q"],
      rows: [["1", "2", null, "", 'x,"y\nz']],
    });
    expect(parsePsqlCsv("id\n")).toEqual({ columns: ["id"], rows: [] });
  });

  it("sqlcmd: header and dashes, NULL, a cell spanning lines", () => {
    const S = "\u001f";
    const out = [
      `id${S}note${S}gone`,
      `--${S}----${S}----`,
      `1${S}first${S}NULL`,
      `2${S}two`,
      `lines${S}x`,
      "",
      "",
    ].join("\r\n");
    expect(parseSqlcmd(out)).toEqual({
      columns: ["id", "note", "gone"],
      rows: [
        ["1", "first", null],
        ["2", "two\nlines", "x"],
      ],
    });
  });

  it("mysql XML: NULL as xsi:nil, entities decoded", () => {
    const out = `<?xml version="1.0"?>

<resultset statement="SELECT id, note, gone FROM t" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <row>
	<field name="id">1</field>
	<field name="note">a &lt;b&gt; &amp; &quot;c&quot;
d</field>
	<field name="gone" xsi:nil="true" />
  </row>
</resultset>
`;
    expect(parseMysqlXml(out)).toEqual({
      columns: ["id", "note", "gone"],
      rows: [["1", 'a <b> & "c"\nd', null]],
    });
  });
});

describe("runAssistantDbQuery", () => {
  it("runs over SSH and parses the result", async () => {
    ssh.results.push({ code: 0, stdout: "id\n1\n", stderr: "" });
    await expect(
      runAssistantDbQuery("env-1", PG, "SELECT id FROM orders", 101)
    ).resolves.toEqual({ columns: ["id"], rows: [["1"]] });
    expect(ssh.calls).toHaveLength(1);
  });

  it("turns an engine error into AssistantDbQueryError without secrets", async () => {
    ssh.results.push({
      code: 1,
      stdout: "",
      stderr: `Login failed for user with password ${MSSQL.password}`,
    });
    const error = await runAssistantDbQuery(
      "env-1",
      MSSQL,
      "SELECT 1",
      101
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AssistantDbQueryError);
    expect((error as Error).message).toContain("Login failed");
    expect((error as Error).message).not.toContain(MSSQL.password);
  });

  it("takes data values out of an engine error before it is thrown or logged", async () => {
    const logged: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    ssh.results.push({
      code: 1,
      stdout: "",
      stderr:
        "Msg 245, Level 16, State 1, Line 1\nConversion failed when converting the varchar value 'rani@example.invalid' to data type int.",
    });
    const error = await runAssistantDbQuery(
      "env-1",
      MSSQL,
      "SELECT id FROM members WHERE email = 1",
      101
    ).catch((e: unknown) => e);
    spy.mockRestore();
    expect((error as Error).message).toContain(
      "varchar value ? to data type int"
    );
    expect((error as Error).message).not.toContain("rani@example.invalid");
    expect(logged.join("\n")).not.toContain("rani@example.invalid");
    expect(logged.length).toBeGreaterThan(0);
  });
});
