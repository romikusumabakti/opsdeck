import { beforeEach, describe, expect, it, vi } from "vitest";

// The Assistant's read-only database login (Stage 9 spec F.2): the generated
// SQL per engine (quoting, escaping, least privilege), the commands that run
// it (secrets on stdin, never in argv) and the redaction of failures. The
// Postgres SQL itself runs against a real cluster in
// tests/assistant-db-provision-scratch.test.ts.

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

const {
  AssistantDbLoginRefused,
  assistantDbLoginName,
  disableAssistantDbLogin,
  enableAssistantDbLogin,
  generateAssistantDbPassword,
  mssqlDisableAssistantDbSql,
  mssqlEnableAssistantDbSql,
  mysqlAssistantDbProbeSql,
  mysqlDisableAssistantDbSql,
  mysqlEnableAssistantDbSql,
  pgDisableAssistantDbSql,
  pgEnableAssistantDbSql,
} = await import("@/lib/assistant-db/provision");
const { assistantDbUnavailableReason } = await import(
  "@/lib/assistant-db/availability"
);

const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789a2";
const ADMIN_PW = "fictional-admin-Pw-31";

const server = {
  id: "0197f3a0-1b2c-7def-8000-0123456789c4",
  host: "db.example.invalid",
  username: "ops",
  password: "fictional-ssh-pw",
  auth: "password" as const,
};

const service = (over: Record<string, unknown> = {}) => ({
  serviceType: "docker" as const,
  serviceName: "kestrel-db",
  dbType: "postgres" as const,
  dbName: "kestrel_qa",
  dbUser: null,
  dbPassword: null,
  dbKind: "container" as const,
  dbRole: null,
  server,
  ...over,
});

describe("assistantDbLoginName", () => {
  it("prefixes a plain database name", () => {
    expect(assistantDbLoginName("postgres", "kestrel_qa")).toBe(
      "menara_ro_kestrel_qa"
    );
  });

  it("hashes a name it had to change, so two names never collide", () => {
    const a = assistantDbLoginName("postgres", "Kestrel-QA");
    const b = assistantDbLoginName("postgres", "kestrel_qa");
    expect(a).toMatch(/^menara_ro_kestrel_qa_[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    expect(assistantDbLoginName("postgres", "a'b\"c]`d")).toMatch(
      /^menara_ro_a_b_c__d_[0-9a-f]{8}$/
    );
  });

  it("fits each engine's name limit", () => {
    const long = "k".repeat(70);
    const pg = assistantDbLoginName("postgres", long);
    const my = assistantDbLoginName("mysql", long);
    const ms = assistantDbLoginName("mssql", long);
    expect(pg.length).toBe(63);
    expect(ms.length).toBe(63);
    expect(my.length).toBe(32);
    for (const name of [pg, my, ms]) expect(name).toMatch(/^[a-z0-9_]+$/);
    // MySQL's 32 characters: a 21-character name still fits as is.
    expect(assistantDbLoginName("mysql", "a".repeat(21))).toBe(
      `menara_ro_${"a".repeat(21)}`
    );
    expect(assistantDbLoginName("mysql", "a".repeat(22))).toMatch(
      /^menara_ro_a{12}_[0-9a-f]{8}$/
    );
  });
});

describe("generateAssistantDbPassword", () => {
  it("is 32 alphanumerics with upper, lower and digit, never repeated", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const pw = generateAssistantDbPassword();
      expect(pw).toMatch(/^[A-Za-z0-9]{32}$/);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[0-9]/);
      seen.add(pw);
    }
    expect(seen.size).toBe(50);
  });
});

describe("assistantDbUnavailableReason", () => {
  const base = {
    dbKind: "container",
    dbType: "postgres",
    dbName: "kestrel_qa",
    hasAdminPassword: false,
  };
  it("refuses external databases, incomplete config and missing admin passwords", () => {
    expect(assistantDbUnavailableReason(base)).toBeNull();
    expect(assistantDbUnavailableReason({ ...base, dbKind: null })).toBeNull();
    expect(assistantDbUnavailableReason({ ...base, dbKind: "shared" })).toBe(
      null
    );
    expect(assistantDbUnavailableReason({ ...base, dbKind: "external" })).toBe(
      "external"
    );
    expect(assistantDbUnavailableReason({ ...base, dbName: null })).toBe(
      "incomplete"
    );
    expect(assistantDbUnavailableReason({ ...base, dbType: "mssql" })).toBe(
      "adminPasswordMissing"
    );
    expect(
      assistantDbUnavailableReason({
        ...base,
        dbType: "mysql",
        hasAdminPassword: true,
      })
    ).toBeNull();
  });
});

describe("pgEnableAssistantDbSql", () => {
  const sql = pgEnableAssistantDbSql({
    database: "kestrel_qa",
    role: "menara_ro_kestrel_qa",
    environmentId: ENV_ID,
    appRoles: ["kestrel_app"],
    adopt: false,
  });

  it("pins the search path before anything else", () => {
    expect(sql.split("\n")[0]).toBe("SET search_path = pg_catalog, pg_temp;");
  });

  it("grants CONNECT on this database only, no predefined roles, no password", () => {
    expect(sql).toContain(
      'GRANT CONNECT ON DATABASE "kestrel_qa" TO "menara_ro_kestrel_qa";'
    );
    expect(sql).not.toMatch(/pg_read_all_data|pg_read_server_files|pg_monitor/);
    expect(sql).not.toMatch(/GRANT\s+"?pg_/i);
    expect(sql).toContain("PASSWORD NULL");
    expect(sql).toMatch(
      /NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/
    );
  });

  it("sets read-only and a 10 s statement timeout on the role", () => {
    expect(sql).toContain(
      'ALTER ROLE "menara_ro_kestrel_qa" SET default_transaction_read_only = on;'
    );
    expect(sql).toContain(
      `ALTER ROLE "menara_ro_kestrel_qa" SET statement_timeout = '10s';`
    );
  });

  it("grants SELECT and default privileges for the owners and the app role", () => {
    expect(sql).toContain("GRANT SELECT ON ALL TABLES IN SCHEMA %I TO %I");
    expect(sql).toContain("GRANT USAGE ON SCHEMA %I TO %I");
    expect(sql).toContain(
      "ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT SELECT ON TABLES TO %I"
    );
    // The app role is named inside the DO body (a doubled-quote literal).
    expect(sql).toContain("rolname = ''kestrel_app''");
  });

  it("marks the role for this environment and refuses one it did not make", () => {
    expect(sql).toContain(`menara:${ENV_ID}`);
    // A first enable refuses any existing role of that name.
    expect(sql).toContain("menara-assistant-login-exists");
  });

  it("verifies the role can't write before committing", () => {
    expect(sql).toContain("has_schema_privilege");
    expect(sql).toContain("has_table_privilege");
    expect(sql).toContain(
      "INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER"
    );
  });

  it("escapes quotes in names so they can't end a literal or identifier", () => {
    const hostile = pgEnableAssistantDbSql({
      database: `x"; DROP DATABASE y; --'`,
      role: `r"'`,
      environmentId: ENV_ID,
      appRoles: [`a'b`],
      adopt: false,
    });
    expect(hostile).toContain(
      `GRANT CONNECT ON DATABASE "x""; DROP DATABASE y; --'" TO "r""'";`
    );
    // Inside the DO literal every quote of a value is doubled twice over.
    expect(hostile).toContain("rolname = ''a''''b''");
  });

  it("refuses an environment id that isn't a uuid", () => {
    expect(() =>
      pgEnableAssistantDbSql({
        database: "d",
        role: "r",
        environmentId: "x' OR '1",
        appRoles: [],
        adopt: false,
      })
    ).toThrow(/uuid/);
  });
});

describe("pgDisableAssistantDbSql", () => {
  it("drops only the marked role, its privileges first", () => {
    const sql = pgDisableAssistantDbSql({
      role: "menara_ro_kestrel_qa",
      environmentId: ENV_ID,
    });
    expect(sql.split("\n")[0]).toBe("SET search_path = pg_catalog, pg_temp;");
    expect(sql).toContain("DROP OWNED BY %I");
    expect(sql).toContain("DROP ROLE %I");
    expect(sql.indexOf("DROP OWNED")).toBeLessThan(sql.indexOf("DROP ROLE"));
    expect(sql).toContain(`menara:${ENV_ID}`);
  });
});

describe("mssqlEnableAssistantDbSql", () => {
  it("creates a login and a db_datareader user, refusing a privileged one", () => {
    const sql = mssqlEnableAssistantDbSql({
      database: "kestrel_qa",
      login: "menara_ro_kestrel_qa",
      password: "Abc123def456ghi789jkl012mno345pq",
      adopt: false,
    });
    expect(sql).toContain("DECLARE @db sysname = N'kestrel_qa';");
    expect(sql).toContain("DECLARE @login sysname = N'menara_ro_kestrel_qa';");
    expect(sql).toContain("QUOTENAME(@pw, '''')");
    expect(sql).toContain("CREATE LOGIN");
    expect(sql).toContain("ALTER ROLE db_datareader ADD MEMBER");
    expect(sql).toContain("sys.server_role_members");
    expect(sql).not.toMatch(/db_datawriter|db_owner|sysadmin\b(?! )/);
  });

  it("escapes quotes in every value it embeds", () => {
    const sql = mssqlEnableAssistantDbSql({
      database: "a'b]c",
      login: "l'x",
      password: "p'w",
      adopt: false,
    });
    expect(sql).toContain("DECLARE @db sysname = N'a''b]c';");
    expect(sql).toContain("DECLARE @login sysname = N'l''x';");
    expect(sql).toContain("DECLARE @pw nvarchar(128) = N'p''w';");
    // Identifiers are bracketed by QUOTENAME at run time, never by hand.
    expect(sql).not.toContain("[a'b]c]");
  });
});

describe("mssqlDisableAssistantDbSql", () => {
  it("drops the user, ends the login's sessions, then drops the login", () => {
    const sql = mssqlDisableAssistantDbSql({
      database: "kestrel_qa",
      login: "menara_ro_kestrel_qa",
    });
    expect(sql).toContain("DROP USER");
    expect(sql).toContain("KILL");
    expect(sql).toContain("DROP LOGIN");
    expect(sql.indexOf("DROP USER")).toBeLessThan(sql.indexOf("DROP LOGIN"));
  });
});

describe("mysqlEnableAssistantDbSql", () => {
  it("grants SELECT on this database only, local TCP only", () => {
    const sql = mysqlEnableAssistantDbSql({
      database: "kestrel_qa",
      user: "menara_ro_kestrel_qa",
      password: "Abc123def456ghi789jkl012mno345pq",
    });
    expect(sql).toContain(
      "CREATE USER IF NOT EXISTS 'menara_ro_kestrel_qa'@'127.0.0.1'"
    );
    expect(sql).toContain(
      "REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'menara_ro_kestrel_qa'@'127.0.0.1';"
    );
    // `_` is a wildcard in a GRANT's database name: escaped, so the grant
    // can't match kestrelXqa.
    expect(sql).toContain(
      "GRANT SELECT ON `kestrel\\_qa`.* TO 'menara_ro_kestrel_qa'@'127.0.0.1';"
    );
    expect(sql).toContain("MAX_USER_CONNECTIONS");
    expect(sql).not.toMatch(/GRANT (ALL|INSERT|UPDATE|DELETE)/);
  });

  it("escapes % and backticks in the database name", () => {
    const sql = mysqlEnableAssistantDbSql({
      database: "a%b`c",
      user: "menara_ro_x",
      password: "Abc1",
    });
    expect(sql).toContain("GRANT SELECT ON `a\\%b``c`.*");
  });

  it("refuses a user or password outside [A-Za-z0-9_]", () => {
    expect(() =>
      mysqlEnableAssistantDbSql({
        database: "d",
        user: "x'@'%",
        password: "Abc1",
      })
    ).toThrow();
    expect(() =>
      mysqlEnableAssistantDbSql({ database: "d", user: "x", password: "a'b" })
    ).toThrow();
  });

  it("drops the user on disable", () => {
    expect(mysqlDisableAssistantDbSql({ user: "menara_ro_x" })).toBe(
      "DROP USER IF EXISTS 'menara_ro_x'@'127.0.0.1';"
    );
  });
});

describe("enableAssistantDbLogin / disableAssistantDbLogin", () => {
  let logged: unknown[][];
  beforeEach(() => {
    ssh.calls = [];
    ssh.results = [];
    logged = [];
    vi.spyOn(console, "error").mockImplementation((...args) => {
      logged.push(args);
    });
  });

  it("postgres: provisions as postgres in the environment's database, then connects as the role", async () => {
    const result = await enableAssistantDbLogin(service(), {
      environmentId: ENV_ID,
      ownLogin: null,
      password: null,
    });
    expect(result).toEqual({ login: "menara_ro_kestrel_qa", password: null });
    const [provision, check] = ssh.calls;
    expect(provision?.command).toMatch(/^docker exec 'kestrel-db' bash -c /);
    expect(provision?.command).toContain(
      "psql -X -q -1 -v ON_ERROR_STOP=on -U postgres -d"
    );
    expect(provision?.command).toContain("kestrel_qa");
    expect(check?.command).toContain("menara_ro_kestrel_qa");
    expect(check?.command).toContain("-U");
  });

  it("postgres: a role that can't connect is dropped again and the error says why", async () => {
    ssh.results = [
      { code: 0, stdout: "", stderr: "" },
      {
        code: 2,
        stdout: "",
        stderr:
          'FATAL:  Peer authentication failed for user "menara_ro_kestrel_qa"',
      },
      { code: 0, stdout: "", stderr: "" },
    ];
    await expect(
      enableAssistantDbLogin(service(), {
        environmentId: ENV_ID,
        ownLogin: null,
        password: null,
      })
    ).rejects.toThrow(/local connections/);
    expect(ssh.calls).toHaveLength(3);
    expect(ssh.calls[2]?.command).toContain("DROP ROLE");
  });

  it("mssql: script and both passwords on stdin, none in argv", async () => {
    const result = await enableAssistantDbLogin(
      service({ dbType: "mssql", dbPassword: ADMIN_PW, dbUser: "sa" }),
      { environmentId: ENV_ID, ownLogin: null, password: null }
    );
    expect(result.login).toBe("menara_ro_kestrel_qa");
    expect(result.password).toMatch(/^[A-Za-z0-9]{32}$/);
    const password = result.password as string;
    const [provision, check] = ssh.calls;
    expect(provision?.command).toMatch(/^docker exec -i 'kestrel-db' bash -c /);
    expect(provision?.stdin?.startsWith(`${ADMIN_PW}\n`)).toBe(true);
    expect(provision?.stdin).toContain(password);
    expect(check?.stdin).toBe(`${password}\n`);
    for (const call of ssh.calls) {
      expect(call.command).not.toContain(password);
      expect(call.command).not.toContain(ADMIN_PW);
    }
  });

  it("mysql: reuses the stored password on a rerun", async () => {
    const reused = "Stored1Password2For3The4Login5ab";
    const result = await enableAssistantDbLogin(
      service({ dbType: "mysql", dbPassword: ADMIN_PW }),
      {
        environmentId: ENV_ID,
        ownLogin: "menara_ro_kestrel_qa",
        password: reused,
      }
    );
    expect(result.password).toBe(reused);
    expect(ssh.calls[0]?.stdin?.startsWith(`${ADMIN_PW}\n`)).toBe(true);
    expect(ssh.calls[0]?.stdin).toContain(`IDENTIFIED BY '${reused}'`);
    expect(ssh.calls[0]?.command).toContain("root");
    expect(ssh.calls[0]?.command).not.toContain(reused);
  });

  it("redacts both passwords from a failure and the log", async () => {
    ssh.results = [
      {
        code: 1,
        stdout: "",
        stderr: `ERROR near 'IDENTIFIED BY' using ${ADMIN_PW}`,
      },
    ];
    const reused = "Stored1Password2For3The4Login5ab";
    const error = await enableAssistantDbLogin(
      service({ dbType: "mysql", dbPassword: ADMIN_PW }),
      {
        environmentId: ENV_ID,
        ownLogin: "menara_ro_kestrel_qa",
        password: reused,
      }
    ).then(
      () => null,
      (e: Error) => e
    );
    expect(error?.message).toContain("[redacted]");
    expect(error?.message).not.toContain(ADMIN_PW);
    const log = JSON.stringify(logged.map((a) => a.map(String)));
    expect(log).not.toContain(ADMIN_PW);
    expect(log).not.toContain(reused);
  });

  it("refuses an external database and a missing admin password before SSH", async () => {
    await expect(
      enableAssistantDbLogin(service({ dbKind: "external" }), {
        environmentId: ENV_ID,
        ownLogin: null,
        password: null,
      })
    ).rejects.toThrow(/external/);
    await expect(
      enableAssistantDbLogin(service({ dbType: "mssql" }), {
        environmentId: ENV_ID,
        ownLogin: null,
        password: null,
      })
    ).rejects.toThrow(/adminPasswordMissing/);
    expect(ssh.calls).toEqual([]);
  });

  it("postgres disable drops the role in its database when it exists", async () => {
    await disableAssistantDbLogin(service(), {
      environmentId: ENV_ID,
      login: "menara_ro_kestrel_qa",
    });
    expect(ssh.calls).toHaveLength(1);
    expect(ssh.calls[0]?.command).toContain("DROP ROLE");
    expect(ssh.calls[0]?.command).toContain("pg_database WHERE datname");
  });

  it("mysql disable runs DROP USER on stdin", async () => {
    await disableAssistantDbLogin(
      service({ dbType: "mysql", dbPassword: ADMIN_PW }),
      { environmentId: ENV_ID, login: "menara_ro_kestrel_qa" }
    );
    expect(ssh.calls[0]?.stdin).toBe(
      `${ADMIN_PW}\nDROP USER IF EXISTS 'menara_ro_kestrel_qa'@'127.0.0.1';\n`
    );
  });
});

describe("never adopting a login the environment doesn't record", () => {
  beforeEach(() => {
    ssh.calls = [];
    ssh.results = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  const fail = (stderr: string) => ({ code: 1, stdout: "", stderr });

  it("postgres SQL refuses any existing role unless adopting, then checks the marker", () => {
    const base = {
      database: "kestrel_qa",
      role: "menara_ro_kestrel_qa",
      environmentId: ENV_ID,
      appRoles: [],
    };
    const fresh = pgEnableAssistantDbSql({ ...base, adopt: false });
    expect(fresh).toContain("menara-assistant-login-exists");
    expect(fresh).not.toContain("was not created by the Panel");
    const own = pgEnableAssistantDbSql({ ...base, adopt: true });
    expect(own).not.toContain("menara-assistant-login-exists");
    expect(own).toContain("was not created by the Panel for this environment");
  });

  it("SQL Server SQL refuses an existing login or user unless adopting, and one mapped into another database", () => {
    const sql = mssqlEnableAssistantDbSql({
      database: "kestrel_qa",
      login: "menara_ro_kestrel_qa",
      password: "Abc1",
      adopt: false,
    });
    expect(sql).toContain("DECLARE @adopt bit = 0;");
    expect(sql).toContain("IF @adopt = 0 AND SUSER_ID(@login) IS NOT NULL");
    expect(sql).toContain(
      "IF @adopt = 0 AND DATABASE_PRINCIPAL_ID(@login) IS NOT NULL"
    );
    expect(sql).toContain("FROM sys.databases WHERE name <> @db");
    expect(sql).toContain("menara-assistant-login-mapped");
    // The mapping check runs before the password could be reset.
    expect(sql.indexOf("menara-assistant-login-mapped")).toBeLessThan(
      sql.indexOf("ALTER LOGIN")
    );
    expect(
      mssqlEnableAssistantDbSql({
        database: "d",
        login: "l",
        password: "Abc1",
        adopt: true,
      })
    ).toContain("DECLARE @adopt bit = 1;");
  });

  it("postgres: an existing role is refused as such and nothing is dropped", async () => {
    ssh.results = [
      fail(
        "ERROR:  menara-assistant-login-exists: role menara_ro_kestrel_qa already exists"
      ),
    ];
    const error = await enableAssistantDbLogin(service(), {
      environmentId: ENV_ID,
      ownLogin: null,
      password: null,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AssistantDbLoginRefused);
    expect(error).toMatchObject({
      reason: "exists",
      login: "menara_ro_kestrel_qa",
    });
    expect(ssh.calls).toHaveLength(1);
  });

  it("mssql: a login mapped into another database is refused and kept", async () => {
    ssh.results = [
      fail("Msg 50000: menara-assistant-login-mapped: [other_db] "),
    ];
    const error = await enableAssistantDbLogin(
      service({ dbType: "mssql", dbPassword: ADMIN_PW }),
      {
        environmentId: ENV_ID,
        ownLogin: "menara_ro_kestrel_qa",
        password: "Stored1Password2For3The4Login5ab",
      }
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: "mapped" });
    expect(ssh.calls).toHaveLength(1);
  });

  it("mssql: a foreign login is refused without dropping it", async () => {
    ssh.results = [fail("Msg 50000: menara-assistant-login-exists: a login")];
    const error = await enableAssistantDbLogin(
      service({ dbType: "mssql", dbPassword: ADMIN_PW }),
      { environmentId: ENV_ID, ownLogin: null, password: null }
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: "exists" });
    expect(ssh.calls).toHaveLength(1);
  });

  it("mssql: a first enable failing halfway drops what it created; a re-enable keeps its login", async () => {
    ssh.results = [fail("Msg 15118: password validation failed")];
    await expect(
      enableAssistantDbLogin(
        service({ dbType: "mssql", dbPassword: ADMIN_PW }),
        { environmentId: ENV_ID, ownLogin: null, password: null }
      )
    ).rejects.toThrow(/15118/);
    expect(ssh.calls).toHaveLength(2);
    expect(ssh.calls[1]?.stdin).toContain("DROP LOGIN");
    ssh.calls = [];
    ssh.results = [fail("Msg 15118: password validation failed")];
    await expect(
      enableAssistantDbLogin(
        service({ dbType: "mssql", dbPassword: ADMIN_PW }),
        {
          environmentId: ENV_ID,
          ownLogin: "menara_ro_kestrel_qa",
          password: "Stored1Password2For3The4Login5ab",
        }
      )
    ).rejects.toThrow(/15118/);
    expect(ssh.calls).toHaveLength(1);
  });

  it("mysql: probes for the user name on any host first; an existing one is refused before any change", async () => {
    expect(mysqlAssistantDbProbeSql("menara_ro_kestrel_qa")).toBe(
      "SELECT COUNT(*) FROM mysql.user WHERE User = 'menara_ro_kestrel_qa';"
    );
    ssh.results = [{ code: 0, stdout: "1\n", stderr: "" }];
    const error = await enableAssistantDbLogin(
      service({ dbType: "mysql", dbPassword: ADMIN_PW }),
      { environmentId: ENV_ID, ownLogin: null, password: null }
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: "exists" });
    expect(ssh.calls).toHaveLength(1);
    expect(ssh.calls[0]?.stdin).toBe(
      `${ADMIN_PW}\nSELECT COUNT(*) FROM mysql.user WHERE User = 'menara_ro_kestrel_qa';\n`
    );
    ssh.calls = [];
    ssh.results = [{ code: 0, stdout: "0\n", stderr: "" }];
    await enableAssistantDbLogin(
      service({ dbType: "mysql", dbPassword: ADMIN_PW }),
      { environmentId: ENV_ID, ownLogin: null, password: null }
    );
    expect(ssh.calls).toHaveLength(3);
    expect(ssh.calls[1]?.stdin).toContain("CREATE USER IF NOT EXISTS");
  });

  it("a recorded login of another name doesn't count as the environment's own", async () => {
    ssh.results = [{ code: 0, stdout: "1", stderr: "" }];
    const error = await enableAssistantDbLogin(
      service({ dbType: "mysql", dbPassword: ADMIN_PW }),
      {
        environmentId: ENV_ID,
        ownLogin: "menara_ro_old_name",
        password: "Stored1Password2For3The4Login5ab",
      }
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: "exists" });
  });
});
