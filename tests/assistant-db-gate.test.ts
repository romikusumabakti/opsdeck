import { describe, expect, it } from "vitest";
import { checkReadOnlyQuery } from "@/lib/assistant-db/gate";
import { isSensitiveName, MASK, maskRows } from "@/lib/assistant-db/mask";
import { redactEngineError, redactLiterals } from "@/lib/assistant-db/redact";

// The Assistant's database gate (Stage 9 spec F.3): exactly one read-only
// SELECT, parsed per engine before anything is sent; sensitive columns are
// masked by name, and selecting one through an alias or an expression is
// refused; the activity log gets the SQL with its literals replaced by `?`.

const refused = (sql: string, engine: "postgres" | "mssql" | "mysql") => {
  const result = checkReadOnlyQuery(sql, engine);
  return result.ok ? "accepted" : result.reason;
};

describe("checkReadOnlyQuery: one read-only SELECT (Review Focus 1)", () => {
  it.each([
    ["SELECT 1; DELETE FROM accounts", "multiple"],
    ["SELECT 1;DELETE FROM accounts;", "multiple"],
    ["SELECT 1 /* ; */; DELETE FROM accounts", "multiple"],
    ["SELECT 1 -- hidden\n; DELETE FROM accounts", "multiple"],
    ["SELECT 1 /* hidden */ FROM accounts", "parse"],
    ["SELECT 1 -- trailing comment", "parse"],
    ["\\! id", "parse"],
    ["SELECT 1 \\g", "parse"],
    // A data-modifying CTE: unparsable (DELETE … RETURNING) or caught in the tree.
    ["WITH x AS (DELETE FROM accounts RETURNING *) SELECT * FROM x", "parse"],
    [
      "WITH x AS (UPDATE accounts SET balance = 0 RETURNING *) SELECT * FROM x",
      "not_select",
    ],
    [
      "SELECT set_config('default_transaction_read_only','off',false)",
      "not_select",
    ],
    [
      "SELECT pg_catalog.set_config('statement_timeout','0',false)",
      "not_select",
    ],
    ["SELECT pg_read_file('/etc/passwd')", "not_select"],
    ["SELECT * FROM pg_ls_dir('.')", "not_select"],
    ["SELECT pg_sleep(60)", "not_select"],
    ["SELECT * FROM dblink('dbname=other', 'select 1')", "not_select"],
    ["SELECT dblink_exec('dbname=other', 'delete from t')", "not_select"],
    ["SELECT lo_import('/etc/passwd')", "not_select"],
    [
      "SELECT query_to_xml('select * from accounts', true, true, '')",
      "not_select",
    ],
    ["SELECT table_to_xml('accounts', true, true, '')", "not_select"],
    ["SELECT nextval('accounts_id_seq')", "not_select"],
    ["SELECT * INTO new_table FROM accounts", "not_select"],
    ["SELECT * FROM accounts FOR UPDATE", "parse"],
    ["DELETE FROM accounts", "not_select"],
    ["UPDATE accounts SET balance = 0", "not_select"],
    ["DROP TABLE accounts", "not_select"],
    [
      "ALTER ROLE menara_ro_x SET default_transaction_read_only = off",
      "parse",
    ],
    ["ALTER TABLE accounts ADD COLUMN x int", "not_select"],
    ["SET default_transaction_read_only = off", "not_select"],
    ["COPY accounts TO PROGRAM 'id'", "parse"],
    ["SELECT $$a$$", "parse"],
    ["SELECT E'a\\'b'", "parse"],
    ["", "parse"],
  ] as const)("postgres refuses %j (%s)", (sql, reason) => {
    expect(refused(sql, "postgres")).toBe(reason);
  });

  it.each([
    ["SELECT 1; EXEC xp_cmdshell 'dir'", "multiple"],
    ["SELECT * INTO #copy FROM accounts", "not_select"],
    ["SELECT * FROM OPENROWSET('SQLNCLI', 'x', 'SELECT 1')", "not_select"],
    ["SELECT * FROM accounts WITH (UPDLOCK)", "not_select"],
    ["SELECT '$(SQLCMDPASSWORD)'", "parse"],
    ["EXEC sp_who", "not_select"],
    ["SELECT * FROM sys.fn_dblog(NULL, NULL)", "not_select"],
  ] as const)("mssql refuses %j (%s)", (sql, reason) => {
    expect(refused(sql, "mssql")).toBe(reason);
  });

  it.each([
    ["SELECT 1; DROP TABLE accounts", "multiple"],
    ["SELECT * FROM accounts INTO OUTFILE '/tmp/x'", "not_select"],
    ["SELECT 1 INTO @x", "not_select"],
    ["SELECT * FROM accounts FOR UPDATE", "not_select"],
    ["SELECT * FROM accounts LOCK IN SHARE MODE", "not_select"],
    ["SELECT LOAD_FILE('/etc/passwd')", "not_select"],
    ["SELECT SLEEP(60)", "not_select"],
    ["SELECT id /*!, secret_note */ FROM accounts", "parse"],
    ["SELECT 1 # comment", "parse"],
    ["SELECT 'a\\'b'", "parse"],
    ["SELECT * FROM accounts LIMIT 5000", "limit"],
    ["SELECT * FROM accounts LIMIT 10, 5000", "limit"],
  ] as const)("mysql refuses %j (%s)", (sql, reason) => {
    expect(refused(sql, "mysql")).toBe(reason);
  });

  it("refuses a string literal that spans lines (CLI meta-commands start a line)", () => {
    expect(refused("SELECT 'a\n\\! id'", "postgres")).toBe("parse");
    expect(refused("SELECT 'a\n!! id'", "mssql")).toBe("parse");
  });

  it("accepts plain reads and returns the text sent, on one line, without the trailing semicolon", () => {
    const result = checkReadOnlyQuery(
      "SELECT id, status\nFROM orders\nWHERE total > 10\nORDER BY id DESC LIMIT 5;\n",
      "postgres"
    );
    expect(result).toMatchObject({
      ok: true,
      normalized:
        "SELECT id, status FROM orders WHERE total > 10 ORDER BY id DESC LIMIT 5",
    });
  });

  it.each([
    [
      "postgres",
      "WITH c AS (SELECT status FROM orders) SELECT status, count(*) AS n FROM c GROUP BY status",
    ],
    [
      "postgres",
      "SELECT id FROM Orders o WHERE o.created_at > now() - interval '1 day'",
    ],
    [
      "postgres",
      "SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id",
    ],
    ["postgres", "SELECT pg_size_pretty(pg_total_relation_size('orders'))"],
    [
      "postgres",
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    ],
    [
      "postgres",
      "SELECT status FROM orders UNION SELECT status FROM archived_orders",
    ],
    ["mssql", "SELECT TOP 5 id, status FROM dbo.orders ORDER BY id DESC"],
    ["mssql", "SELECT id FROM orders WITH (NOLOCK) WHERE status = N'paid'"],
    ["mysql", "SELECT id, status FROM orders WHERE status = 'paid' LIMIT 50"],
    ["mysql", "SELECT @@version"],
    ["mysql", "SELECT COUNT(*) FROM orders"],
    ["mssql", "SELECT COUNT(*) AS n FROM dbo.orders"],
    ["mssql", "SELECT TOP 5 * FROM dbo.orders"],
    ["postgres", "SELECT count(*) FROM orders"],
    ["postgres", "SELECT o.* FROM orders o"],
  ] as const)("%s accepts %j", (engine, sql) => {
    expect(checkReadOnlyQuery(sql, engine).ok).toBe(true);
  });
});

describe("checkReadOnlyQuery: sensitive columns (Review Focus 3)", () => {
  it.each([
    "SELECT nik AS x FROM members",
    "SELECT lower(email) FROM members",
    "SELECT concat(first_name, phone) FROM members",
    "SELECT email || '' FROM members",
    "SELECT email::text FROM members",
    "SELECT max(password_hash) FROM members",
    "SELECT CASE WHEN true THEN npwp END FROM members",
    "SELECT x FROM (SELECT email AS x FROM members) s",
    "SELECT (SELECT max(email) FROM members) AS y",
    "WITH c(x) AS (SELECT email FROM members) SELECT x FROM c",
    "WITH c(x) AS (SELECT * FROM members) SELECT x FROM c",
    "SELECT x FROM members AS m(x)",
    "SELECT m FROM members m",
    "SELECT row_to_json(m.*) FROM members m",
    "SELECT json_agg(m) FROM members m",
    "SELECT m::text FROM members m",
    "SELECT id FROM members m WHERE to_jsonb(m)::text LIKE '%x%'",
    "SELECT data->>'email' FROM members",
    "SELECT id FROM members ORDER BY lower(email)",
    "SELECT id FROM members WHERE email::int = 1",
    "SELECT name FROM a UNION SELECT email FROM b",
    "SELECT * FROM a UNION SELECT * FROM b",
  ])("postgres refuses %j as wrapped_sensitive", (sql) => {
    expect(refused(sql, "postgres")).toBe("wrapped_sensitive");
  });

  it("mssql refuses the x = email alias form", () => {
    expect(refused("SELECT x = email FROM members", "mssql")).toBe(
      "wrapped_sensitive"
    );
    expect(refused("SELECT email x FROM members", "mysql")).toBe(
      "wrapped_sensitive"
    );
  });

  it("accepts sensitive columns selected plainly, filtered or counted", () => {
    for (const sql of [
      "SELECT email FROM members",
      "SELECT m.email AS email FROM members m",
      "SELECT email AS contact_email FROM members",
      "SELECT id FROM members WHERE email = 'a@example.invalid'",
      "SELECT id FROM members WHERE email LIKE '%@example.invalid' AND phone IS NULL",
      "SELECT count(email), count(DISTINCT nik) FROM members",
      "SELECT * FROM members",
      "SELECT shipment_date, lower(status) FROM orders",
    ]) {
      expect(refused(sql, "postgres"), sql).toBe("accepted");
    }
  });

  it("resolves the output columns and marks the sensitive ones", () => {
    const result = checkReadOnlyQuery(
      "SELECT m.id, m.email, shipment_date AS shipped, * FROM members m",
      "postgres"
    );
    expect(result.ok && result.outputColumns).toEqual([
      { name: "id", sources: ["id"], sensitive: false, star: false },
      { name: "email", sources: ["email"], sensitive: true, star: false },
      {
        name: "shipped",
        sources: ["shipment_date"],
        sensitive: false,
        star: false,
      },
      { name: null, sources: [], sensitive: false, star: true },
    ]);
  });

  it("explains a refusal so the model can rewrite the query", () => {
    const result = checkReadOnlyQuery(
      "SELECT nik AS x FROM members",
      "postgres"
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/nik/);
    expect(!result.ok && result.message).toMatch(/plainly/);
  });
});

describe("isSensitiveName", () => {
  it.each([
    "password",
    "password_hash",
    "passwordHash",
    "PASSWD",
    "client_secret",
    "access_token",
    "refreshTokens",
    "api_key",
    "apiKey",
    "APIKey",
    "pin",
    "otp_code",
    "nik",
    "no_npwp",
    "ktp_number",
    "email",
    "Email",
    "e_mail",
    "emails",
    "phone",
    "phoneNumber",
    "no_hp",
    "mobile",
    "home_address",
    "addresses",
    "alamat",
    "birth_date",
    "dateOfBirth",
    "tgl_lahir",
    "dob",
    "nomor_rekening",
    "account_number",
    "accountNumber",
    "card_number",
  ])("masks %s", (name) => {
    expect(isSensitiveName(name)).toBe(true);
  });

  it.each([
    "shipment_date",
    "discard",
    "shipping",
    "pinned_at",
    "opinion",
    "account_id",
    "card_type",
    "mobility",
    "id",
    "status",
    "",
  ])("does not mask %s", (name) => {
    expect(isSensitiveName(name)).toBe(false);
  });
});

describe("maskRows", () => {
  it("masks by result name without the gate's flags (SELECT *)", () => {
    const result = maskRows(
      ["id", "password_hash", "shipment_date"],
      [
        ["1", "$2b$hash", "2026-01-01"],
        ["2", null, "2026-01-02"],
      ]
    );
    expect(result.rows).toEqual([
      ["1", MASK, "2026-01-01"],
      ["2", MASK, "2026-01-02"],
    ]);
    expect(result.masked).toEqual(["password_hash"]);
  });

  it("follows the gate's flags when there is one per column", () => {
    const result = maskRows(
      ["id", "email_count", "x"],
      [["1", "42", "a"]],
      [false, false, true]
    );
    expect(result.rows).toEqual([["1", "42", MASK]]);
    expect(result.masked).toEqual(["x"]);
  });
});

describe("checkReadOnlyQuery: aliases spelled as reserved words", () => {
  it.each([
    "SELECT 1 shutdown",
    "SELECT 1 checkpoint",
    "SELECT 1 reconfigure",
    "SELECT 1 setuser",
    "SELECT 1 revert",
    "SELECT 1 commit",
    "SELECT 1 rollback",
    "SELECT 1 throw",
    "SELECT id FROM orders shutdown",
    "SELECT 1 x, 2 checkpoint",
    "SELECT id AS checkpoint FROM orders",
  ])("mssql refuses %j", (sql) => {
    expect(refused(sql, "mssql")).toBe("not_select");
  });

  it("mssql accepts only plain aliases", () => {
    expect(refused("SELECT 1 AS [Total Amount]", "mssql")).toBe("parse");
    expect(refused("SELECT id total, o.status FROM orders o", "mssql")).toBe(
      "accepted"
    );
  });

  it("postgres and mysql refuse reserved-word aliases too", () => {
    expect(refused('SELECT 1 AS "select"', "postgres")).toBe("not_select");
    expect(refused("SELECT 1 AS `lock`", "mysql")).toBe("not_select");
    expect(refused("SELECT 1 AS total", "postgres")).toBe("accepted");
  });
});

describe("checkReadOnlyQuery: counts of sensitive columns", () => {
  it("resolves a count as not sensitive, whatever its alias", () => {
    const result = checkReadOnlyQuery(
      "SELECT count(email), count(DISTINCT nik) AS nik_count, email FROM members GROUP BY email",
      "postgres"
    );
    expect(result.ok && result.outputColumns.map((c) => c.sensitive)).toEqual([
      false,
      false,
      true,
    ]);
  });
});

describe("redactLiterals", () => {
  it.each([
    [
      "SELECT id FROM members WHERE nik = '3201234567890001' AND age > 40",
      "SELECT id FROM members WHERE nik = ? AND age > ?",
    ],
    [
      "SELECT * FROM t1 WHERE x = 1.5e3 OR y = -7",
      "SELECT * FROM t1 WHERE x = ? OR y = -?",
    ],
    ["SELECT 'it''s', N'nama', E'x' FROM t", "SELECT ?, ?, ? FROM t"],
    [
      'SELECT "Name" FROM "Table2" WHERE a = $$secret$$',
      'SELECT "Name" FROM "Table2" WHERE a = ?',
    ],
    ["SELECT 1 -- nik 3201\nFROM t /* 99 */", "SELECT ? FROM t"],
  ])("%j → %j", (sql, expected) => {
    expect(redactLiterals(sql)).toBe(expected);
  });

  it("keeps SQL Server bracketed names", () => {
    expect(
      redactLiterals("SELECT [col 1] FROM t WHERE c = 0x1F", "mssql")
    ).toBe("SELECT [col 1] FROM t WHERE c = ?");
  });

  it("treats double quotes as strings on MySQL", () => {
    expect(redactLiterals('SELECT a FROM t WHERE b = "secret"', "mysql")).toBe(
      "SELECT a FROM t WHERE b = ?"
    );
  });

  it("hides everything after the first quote when a backslash makes quoting ambiguous", () => {
    expect(redactLiterals("SELECT 'a\\' , nik FROM t WHERE x = 'secret'")).toBe(
      "SELECT ?"
    );
  });

  it("redacts an unterminated literal to the end", () => {
    expect(redactLiterals("SELECT 'secret")).toBe("SELECT ?");
  });
});

describe("redactEngineError", () => {
  it.each([
    [
      "mssql Msg 245",
      "Msg 245, Level 16, State 1, Server db1, Line 1\nConversion failed when converting the varchar value 'rani@example.invalid' to data type int.",
      "Msg 245, Level 16, State 1, Server db1, Line 1\nConversion failed when converting the varchar value ? to data type int.",
    ],
    [
      "mssql Msg 8114",
      "Msg 8114, Level 16, State 5, Line 1\nError converting data type nvarchar to numeric. Value N'3201234567890001'",
      "Msg 8114, Level 16, State 5, Line 1\nError converting data type nvarchar to numeric. Value N?",
    ],
    [
      "postgres invalid input",
      'ERROR:  invalid input syntax for type integer: "3201234567890001"\nLINE 1: SELECT * FROM (SELECT id FROM members WHERE nik = 1) AS menara_q LIMIT 101\n                                                            ^',
      "ERROR:  invalid input syntax for type integer: ?\nLINE 1: SELECT * FROM (SELECT id FROM members WHERE nik = 1) AS menara_q LIMIT 101\n                                                            ^",
    ],
    [
      "postgres DETAIL and CONTEXT",
      'ERROR:  duplicate key value violates unique constraint "members_email_key"\nDETAIL:  Key (email)=(rani@example.invalid) already exists.\nCONTEXT:  SQL function "f" statement 1',
      "ERROR:  duplicate key value violates unique constraint ?",
    ],
    [
      "postgres Key value inline",
      "ERROR:  conflict: Key (nik)=(3201 (old)) already exists.",
      "ERROR:  conflict: Key (nik)=(?) already exists.",
    ],
    [
      "mysql truncated value",
      "ERROR 1292 (22007) at line 1: Truncated incorrect DOUBLE value: 'rani@example.invalid'",
      "ERROR 1292 (22007) at line 1: Truncated incorrect DOUBLE value: ?",
    ],
    [
      "mysql unknown column",
      "ERROR 1054 (42S22) at line 1: Unknown column 'emial' in 'field list'",
      "ERROR 1054 (42S22) at line 1: Unknown column ?",
    ],
  ])("%s", (_, error, expected) => {
    expect(redactEngineError(error)).toBe(expected);
  });

  it("hides an unterminated quote to the end", () => {
    expect(redactEngineError("value 'rani@exam\nnext line")).toBe("value ?");
  });

  // Engines print values raw: embedded quotes and line breaks are not escaped.
  it.each([
    [
      "mssql Msg 245, embedded quote",
      "Msg 245, Level 16, State 1, Line 1\nConversion failed when converting the varchar value 'O'Brien x' to data type int.",
      "Msg 245, Level 16, State 1, Line 1\nConversion failed when converting the varchar value ? to data type int.",
    ],
    [
      "mssql Msg 245, embedded newline",
      "Msg 245, Level 16, State 1, Line 1\nConversion failed when converting the varchar value 'Jl. Mawar 1\nRT 02 secret' to data type int.",
      "Msg 245, Level 16, State 1, Line 1\nConversion failed when converting the varchar value ? to data type int.",
    ],
    [
      "postgres, embedded double quotes",
      'ERROR:  invalid input syntax for type integer: "a"secret"b"\nLINE 1: SELECT * FROM (SELECT id FROM t WHERE x = 1) AS menara_q',
      "ERROR:  invalid input syntax for type integer: ?\nLINE 1: SELECT * FROM (SELECT id FROM t WHERE x = 1) AS menara_q",
    ],
    [
      "postgres, embedded newline and a fake DETAIL",
      'ERROR:  invalid input syntax for type integer: "line one\nsecret two"\nLINE 1: SELECT 1',
      "ERROR:  invalid input syntax for type integer: ?\nLINE 1: SELECT 1",
    ],
    [
      "postgres, value spanning a DETAIL-looking line",
      'ERROR:  invalid input syntax for type integer: "x\nDETAIL: secret"',
      "ERROR:  invalid input syntax for type integer: ?",
    ],
    [
      "mysql, embedded quote and newline",
      "ERROR 1292 (22007) at line 1: Truncated incorrect DOUBLE value: 'O'Brien\nsecret'",
      "ERROR 1292 (22007) at line 1: Truncated incorrect DOUBLE value: ?",
    ],
    ["mixed quote kinds", "value 'a \"b' then \"c' secret\"", "value ?"],
    [
      "postgres, a quoted literal in the echoed query",
      "ERROR:  invalid input syntax for type integer: \"x\"\nLINE 1: SELECT 1 WHERE a = 'secret'",
      "ERROR:  invalid input syntax for type integer: ?",
    ],
  ])("%s", (_, error, expected) => {
    const out = redactEngineError(error);
    expect(out).toBe(expected);
    for (const word of ["Brien", "secret", "RT 02", "two"]) {
      expect(out).not.toContain(word);
    }
  });
});
