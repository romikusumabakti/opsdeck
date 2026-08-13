import { describe, expect, it } from "bun:test";
import {
  buildExtractCommand,
  buildMssqlMoveClauses,
  buildPlaceCommand,
  buildRemovePlacedCommand,
  type CommandTargetEnvironment,
  dbOsUser,
  mssqlBackupQuery,
  mssqlCreateDatabaseQuery,
  mssqlDropDatabaseQuery,
  mssqlFileListQuery,
  mssqlRenameDatabaseQuery,
  mssqlRestoreQuery,
  parseMssqlFileList,
  pgBackupPipeline,
  pgCreateDatabaseQuery,
  pgDropDatabaseQuery,
  pgPsqlPipeline,
  pgQuoteId,
  pgQuoteLiteral,
  pgRecreateDatabaseQuery,
  pgRenameDatabaseQuery,
  pgRestorePipeline,
  posixDirname,
  sqlBracketId,
  sqlQuoteString,
} from "@/lib/jobs/commands";

// These builders produce the exact text that runs on a customer's database
// server over SSH. The tests assert on the produced command rather than on
// behaviour, because the command IS the behaviour — and the failure mode being
// guarded against is a quoting rule that stops holding.

// Values that a database name, filename or path could carry if any layer above
// stopped validating: shell metacharacters, quote characters that would close
// a SQL literal or identifier early, and newlines.
const HOSTILE = [
  "a'; DROP DATABASE prod; --",
  'a"; DROP DATABASE prod; --',
  "a]; DROP DATABASE [prod",
  "a`whoami`",
  "a$(whoami)",
  "a; rm -rf /",
  "a | tee /etc/passwd",
  "a\nDROP DATABASE prod;",
  "a && reboot",
  "a'",
  'a"',
  "a]",
];

describe("escaping", () => {
  describe("sqlQuoteString (T-SQL literal body)", () => {
    it("doubles a single quote", () => {
      expect(sqlQuoteString("O'Brien")).toBe("O''Brien");
    });

    it("doubles every quote, not only the first", () => {
      expect(sqlQuoteString("'a'b'")).toBe("''a''b''");
    });

    it("leaves a quote-free value untouched", () => {
      expect(sqlQuoteString("/var/opt/mssql/backup/db.bak")).toBe(
        "/var/opt/mssql/backup/db.bak"
      );
    });

    it("leaves an already-escaped value balanced when re-wrapped", () => {
      // The result is embedded in N'...', so an even number of quotes in the
      // body is what keeps the literal from closing early.
      for (const value of HOSTILE) {
        const quotes = sqlQuoteString(value).match(/'/g)?.length ?? 0;
        expect(quotes % 2).toBe(0);
      }
    });
  });

  describe("sqlBracketId (T-SQL [identifier] body)", () => {
    it("doubles a closing bracket", () => {
      expect(sqlBracketId("we]ird")).toBe("we]]ird");
    });

    it("does not touch an opening bracket", () => {
      // Only `]` terminates a bracketed identifier; `[` inside one is literal.
      expect(sqlBracketId("we[ird")).toBe("we[ird");
    });

    it("never leaves a lone bracket that would close the identifier", () => {
      for (const value of HOSTILE) {
        const escaped = sqlBracketId(value);
        // Every `]` must be part of a `]]` pair.
        expect(escaped.replace(/]]/g, "")).not.toContain("]");
      }
    });
  });

  describe("pgQuoteId (Postgres identifier, quotes included)", () => {
    it("wraps in double quotes", () => {
      expect(pgQuoteId("mydb")).toBe('"mydb"');
    });

    it("doubles an embedded double quote", () => {
      expect(pgQuoteId('we"ird')).toBe('"we""ird"');
    });

    it("never lets a value close the identifier early", () => {
      for (const value of HOSTILE) {
        const quoted = pgQuoteId(value);
        expect(quoted.startsWith('"')).toBe(true);
        expect(quoted.endsWith('"')).toBe(true);
        // Strip the wrapper, then the escaped pairs: nothing may remain.
        const body = quoted.slice(1, -1);
        expect(body.replace(/""/g, "")).not.toContain('"');
      }
    });

    it("does not treat a single quote as special", () => {
      // A `'` is ordinary inside a Postgres identifier — escaping it would
      // rename the database to something the operator didn't ask for.
      expect(pgQuoteId("o'brien")).toBe(`"o'brien"`);
    });
  });

  describe("pgQuoteLiteral (Postgres string literal, quotes included)", () => {
    it("wraps in single quotes", () => {
      expect(pgQuoteLiteral("mydb")).toBe("'mydb'");
    });

    it("doubles an embedded single quote", () => {
      expect(pgQuoteLiteral("o'brien")).toBe("'o''brien'");
    });

    it("never lets a value close the literal early", () => {
      for (const value of HOSTILE) {
        const body = pgQuoteLiteral(value).slice(1, -1);
        expect(body.replace(/''/g, "")).not.toContain("'");
      }
    });
  });
});

describe("posixDirname", () => {
  it("returns the parent directory", () => {
    expect(posixDirname("/var/opt/mssql/data/car2.mdf")).toBe(
      "/var/opt/mssql/data"
    );
  });

  it("returns / for a path directly under root", () => {
    expect(posixDirname("/car2.mdf")).toBe("/");
  });

  it("returns / for a bare name with no separator", () => {
    expect(posixDirname("car2.mdf")).toBe("/");
  });

  it("keeps POSIX semantics regardless of the panel's platform", () => {
    // node:path would split on `\` when the panel runs on Windows; these paths
    // live on the remote Linux host, so a backslash is an ordinary character.
    expect(posixDirname("C:\\data\\car2.mdf")).toBe("/");
  });
});

describe("dbOsUser", () => {
  it("maps each engine to the OS user it runs as", () => {
    expect(dbOsUser("postgres")).toBe("postgres");
    expect(dbOsUser("mssql")).toBe("mssql");
  });
});

describe("Postgres statements", () => {
  it("recreates with FORCE so an open connection can't block the drop", () => {
    expect(pgRecreateDatabaseQuery("car2")).toBe(
      `DROP DATABASE IF EXISTS "car2" WITH (FORCE); CREATE DATABASE "car2";`
    );
  });

  it("drops with IF EXISTS and FORCE", () => {
    expect(pgDropDatabaseQuery("car2")).toBe(
      `DROP DATABASE IF EXISTS "car2" WITH (FORCE);`
    );
  });

  it("creates with a quoted identifier", () => {
    expect(pgCreateDatabaseQuery("car2")).toBe(`CREATE DATABASE "car2";`);
  });

  it("terminates other backends before renaming, sparing its own", () => {
    const query = pgRenameDatabaseQuery("car2", "car3");
    expect(query).toContain("pg_terminate_backend(pid)");
    expect(query).toContain("datname = 'car2'");
    // Without this the statement kills the very session issuing it.
    expect(query).toContain("pid <> pg_backend_pid()");
    expect(query).toContain(`ALTER DATABASE "car2" RENAME TO "car3";`);
  });

  it("quotes both sides of a rename as identifiers", () => {
    const query = pgRenameDatabaseQuery('a"b', 'c"d');
    expect(query).toContain(`ALTER DATABASE "a""b" RENAME TO "c""d";`);
  });

  // The WHERE clause compares a VALUE and the ALTER names an IDENTIFIER. They
  // need different escaping, and using one rule for both is the classic bug.
  it("uses literal quoting in WHERE and identifier quoting in ALTER", () => {
    const query = pgRenameDatabaseQuery("o'brien", "smith");
    expect(query).toContain("datname = 'o''brien'");
    expect(query).toContain(`ALTER DATABASE "o'brien" RENAME TO "smith"`);
  });

  describe("pgPsqlPipeline", () => {
    it("stops at the first failing statement", () => {
      expect(pgPsqlPipeline("SELECT 1;")).toContain("-v ON_ERROR_STOP=on");
    });

    it("connects to the postgres maintenance database, not the target", () => {
      // A DROP/CREATE cannot run from inside the database it operates on.
      expect(pgPsqlPipeline("SELECT 1;")).toContain("-d postgres");
    });

    it("passes the query as a single quoted shell argument", () => {
      const cmd = pgPsqlPipeline(pgDropDatabaseQuery("a'; rm -rf /; #"));
      // shq wraps in single quotes and escapes any embedded ones, so the
      // metacharacters never reach the shell as syntax.
      expect(cmd.startsWith("printf '%s\\n' '")).toBe(true);
      expect(cmd).not.toContain("; rm -rf /; #' |");
    });
  });

  describe("pgBackupPipeline", () => {
    it("dumps to the target uncompressed", () => {
      expect(pgBackupPipeline("car2", "/backups/car2.sql", false)).toBe(
        `pg_dump -U postgres --clean --if-exists 'car2' > '/backups/car2.sql'`
      );
    });

    it("pipes through gzip with pipefail when compressing", () => {
      const cmd = pgBackupPipeline("car2", "/backups/car2.sql.gz", true);
      // Without pipefail, a failed pg_dump is masked by gzip's exit 0 and the
      // run is recorded as a success with a truncated backup.
      expect(cmd.startsWith("set -o pipefail; ")).toBe(true);
      expect(cmd).toContain("| gzip > '/backups/car2.sql.gz'");
    });

    it("emits --clean --if-exists so a re-restore doesn't collide", () => {
      expect(pgBackupPipeline("car2", "/b/c.sql", false)).toContain(
        "--clean --if-exists"
      );
    });

    it("quotes a hostile database name into a single argument", () => {
      const cmd = pgBackupPipeline("a'; rm -rf /", "/b/c.sql", false);
      expect(cmd).toContain(`'a'\\''; rm -rf /'`);
    });
  });

  describe("pgRestorePipeline", () => {
    it("redirects a plain .sql dump into psql", () => {
      expect(pgRestorePipeline("car2", "/b/car2.sql", false)).toBe(
        `psql -v ON_ERROR_STOP=on -U postgres -d 'car2' < '/b/car2.sql'`
      );
    });

    it("gunzips a .gz dump through a pipefail pipeline", () => {
      const cmd = pgRestorePipeline("car2", "/b/car2.sql.gz", true);
      expect(cmd.startsWith("set -o pipefail; gunzip -c ")).toBe(true);
      expect(cmd).toContain("| psql -v ON_ERROR_STOP=on -U postgres -d 'car2'");
    });

    it("connects to the target database, not postgres", () => {
      expect(pgRestorePipeline("car2", "/b/c.sql", false)).toContain(
        "-d 'car2'"
      );
    });
  });
});

describe("SQL Server statements", () => {
  it("backs up with the requested compression clause", () => {
    expect(mssqlBackupQuery("car2", "/b/car2.bak", true)).toBe(
      `BACKUP DATABASE [car2] TO DISK = N'/b/car2.bak' WITH FORMAT, INIT, COMPRESSION, STATS = 5`
    );
    expect(mssqlBackupQuery("car2", "/b/car2.bak", false)).toContain(
      "NO_COMPRESSION"
    );
  });

  it("escapes the target path as a literal and the name as an identifier", () => {
    const query = mssqlBackupQuery("we]ird", "/b/o'brien.bak", true);
    expect(query).toContain("BACKUP DATABASE [we]]ird]");
    expect(query).toContain(`TO DISK = N'/b/o''brien.bak'`);
  });

  it("creates with a bracketed identifier", () => {
    expect(mssqlCreateDatabaseQuery("car2")).toBe("CREATE DATABASE [car2];");
    expect(mssqlCreateDatabaseQuery("we]ird")).toBe(
      "CREATE DATABASE [we]]ird];"
    );
  });

  describe("mssqlDropDatabaseQuery", () => {
    it("guards on existence so dropping a missing database is a no-op", () => {
      expect(mssqlDropDatabaseQuery("car2")).toContain(
        "IF DB_ID(N'car2') IS NOT NULL"
      );
    });

    it("kills connections before dropping", () => {
      const query = mssqlDropDatabaseQuery("car2");
      const alterAt = query.indexOf("SET SINGLE_USER WITH ROLLBACK IMMEDIATE");
      const dropAt = query.indexOf("DROP DATABASE");
      expect(alterAt).toBeGreaterThan(-1);
      // Order matters: a DROP with live sessions fails.
      expect(alterAt).toBeLessThan(dropAt);
    });

    it("uses literal quoting in DB_ID and bracket quoting in the DDL", () => {
      const query = mssqlDropDatabaseQuery("o'br]ien");
      expect(query).toContain(`IF DB_ID(N'o''br]ien') IS NOT NULL`);
      expect(query).toContain("DROP DATABASE [o'br]]ien];");
    });
  });

  describe("mssqlRenameDatabaseQuery", () => {
    it("kills connections, renames, then restores MULTI_USER", () => {
      expect(mssqlRenameDatabaseQuery("car2", "car3")).toBe(
        "ALTER DATABASE [car2] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;\n" +
          "ALTER DATABASE [car2] MODIFY NAME = [car3];\n" +
          "ALTER DATABASE [car3] SET MULTI_USER;"
      );
    });

    it("returns the NEW name to MULTI_USER, not the old one", () => {
      // After MODIFY NAME the old identifier no longer resolves, so a
      // MULTI_USER on the source would leave the database stuck single-user.
      const lines = mssqlRenameDatabaseQuery("car2", "car3").split("\n");
      expect(lines[2]).toContain("[car3]");
      expect(lines[2]).not.toContain("[car2]");
    });

    it("escapes both identifiers", () => {
      const query = mssqlRenameDatabaseQuery("a]b", "c]d");
      expect(query).toContain("[a]]b]");
      expect(query).toContain("[c]]d]");
    });
  });

  describe("mssqlFileListQuery", () => {
    it("reads the file list from the given disk path", () => {
      expect(mssqlFileListQuery("/b/car2.bak")).toBe(
        `RESTORE FILELISTONLY FROM DISK = N'/b/car2.bak';`
      );
    });

    it("escapes a quote in the path", () => {
      expect(mssqlFileListQuery("/b/o'brien.bak")).toBe(
        `RESTORE FILELISTONLY FROM DISK = N'/b/o''brien.bak';`
      );
    });
  });

  describe("mssqlRestoreQuery", () => {
    const query = mssqlRestoreQuery("car3", "/b/car2.bak", [
      "  MOVE N'car2' TO N'/var/opt/mssql/data/car3.mdf'",
    ]);

    it("always passes REPLACE first, then the MOVE clauses", () => {
      expect(query).toContain("WITH\n  REPLACE,\n    MOVE N'car2'");
    });

    it("flips back to MULTI_USER on the failure path too", () => {
      // Without the CATCH branch a failed restore leaves the database wedged
      // in single-user mode and the next attempt can't even connect.
      const catchAt = query.indexOf("BEGIN CATCH");
      expect(query.indexOf("SET MULTI_USER", catchAt)).toBeGreaterThan(catchAt);
    });

    it("rethrows the real SQL error number and message", () => {
      expect(query).toContain("ERROR_NUMBER()");
      expect(query).toContain("ERROR_MESSAGE()");
      expect(query).toContain("THROW 50000, @msg, 1;");
    });

    it("guards every DB_ID check so a fresh restore doesn't error", () => {
      // The target may not exist yet; ALTER DATABASE on a missing name fails.
      const guards = query.match(/IF DB_ID\(N'car3'\) IS NOT NULL/g) ?? [];
      expect(guards.length).toBe(3);
    });

    it("escapes the database name in both quoting styles", () => {
      const hostile = mssqlRestoreQuery("o'br]ien", "/b/c.bak", []);
      expect(hostile).toContain(`DB_ID(N'o''br]ien')`);
      expect(hostile).toContain("[o'br]]ien]");
    });
  });
});

describe("parseMssqlFileList", () => {
  const OUTPUT = [
    "car2~/var/opt/mssql/data/car2.mdf~D~PRIMARY",
    "car2_log~/var/opt/mssql/data/car2_log.ldf~L~NULL",
    "",
    "(2 rows affected)",
  ].join("\n");

  it("parses logical name, physical path and type", () => {
    expect(parseMssqlFileList(OUTPUT)).toEqual([
      { logical: "car2", physical: "/var/opt/mssql/data/car2.mdf", type: "D" },
      {
        logical: "car2_log",
        physical: "/var/opt/mssql/data/car2_log.ldf",
        type: "L",
      },
    ]);
  });

  it("drops sqlcmd's trailing row-count line", () => {
    expect(
      parseMssqlFileList(OUTPUT).some((f) =>
        f.logical.includes("rows affected")
      )
    ).toBe(false);
  });

  it("accepts FILESTREAM and full-text file types", () => {
    expect(parseMssqlFileList("s~/d/s.ndf~S\nf~/d/f.ft~F")).toHaveLength(2);
  });

  it("ignores a row with an unknown type", () => {
    expect(parseMssqlFileList("x~/d/x.dat~Z")).toEqual([]);
  });

  it("ignores a row with too few columns", () => {
    expect(parseMssqlFileList("only~two")).toEqual([]);
  });

  it("trims sqlcmd padding", () => {
    expect(parseMssqlFileList("  car2  ~  /d/car2.mdf  ~  d  ")).toEqual([
      { logical: "car2", physical: "/d/car2.mdf", type: "D" },
    ]);
  });

  it("returns nothing for empty output, so the caller can raise", () => {
    expect(parseMssqlFileList("")).toEqual([]);
  });
});

describe("buildMssqlMoveClauses", () => {
  const FILES = [
    { logical: "car2", physical: "/var/opt/mssql/data/car2.mdf", type: "D" },
    {
      logical: "car2_log",
      physical: "/var/opt/mssql/data/car2_log.ldf",
      type: "L",
    },
  ];

  it("renames files after the TARGET database, not the source", () => {
    // This is the whole point: without it, restoring car2's .bak into car3
    // fails with Msg 1834 because the stored paths point at car2's live files.
    expect(buildMssqlMoveClauses(FILES, "car3")).toEqual([
      `  MOVE N'car2' TO N'/var/opt/mssql/data/car3.mdf'`,
      `  MOVE N'car2_log' TO N'/var/opt/mssql/data/car3_log.ldf'`,
    ]);
  });

  it("keeps each file in its original directory", () => {
    const clauses = buildMssqlMoveClauses(
      [{ logical: "d", physical: "/other/place/d.mdf", type: "D" }],
      "car3"
    );
    expect(clauses[0]).toContain("/other/place/car3.mdf");
  });

  it("gives the first data file .mdf and the rest .ndf", () => {
    const clauses = buildMssqlMoveClauses(
      [
        { logical: "a", physical: "/d/a.mdf", type: "D" },
        { logical: "b", physical: "/d/b.ndf", type: "D" },
        { logical: "c", physical: "/d/c.ndf", type: "D" },
      ],
      "car3"
    );
    expect(clauses[0]).toContain("/d/car3.mdf");
    expect(clauses[1]).toContain("/d/car3_1.ndf");
    expect(clauses[2]).toContain("/d/car3_2.ndf");
  });

  it("numbers additional log files without colliding", () => {
    const clauses = buildMssqlMoveClauses(
      [
        { logical: "l1", physical: "/d/l1.ldf", type: "L" },
        { logical: "l2", physical: "/d/l2.ldf", type: "L" },
      ],
      "car3"
    );
    expect(clauses[0]).toContain("/d/car3_log.ldf");
    expect(clauses[1]).toContain("/d/car3_log_1.ldf");
  });

  it("never maps two files onto the same physical path", () => {
    const clauses = buildMssqlMoveClauses(
      [
        { logical: "a", physical: "/d/a.mdf", type: "D" },
        { logical: "b", physical: "/d/b.ndf", type: "D" },
        { logical: "l1", physical: "/d/l1.ldf", type: "L" },
        { logical: "l2", physical: "/d/l2.ldf", type: "L" },
        { logical: "s", physical: "/d/s.ndf", type: "S" },
      ],
      "car3"
    );
    const targets = clauses.map((c) => c.split(" TO ")[1]);
    expect(new Set(targets).size).toBe(clauses.length);
  });

  it("escapes quotes in the logical name and the new path", () => {
    const clauses = buildMssqlMoveClauses(
      [{ logical: "o'brien", physical: "/d/x.mdf", type: "D" }],
      "car'3"
    );
    expect(clauses[0]).toBe(`  MOVE N'o''brien' TO N'/d/car''3.mdf'`);
  });

  it("returns nothing for no files", () => {
    expect(buildMssqlMoveClauses([], "car3")).toEqual([]);
  });
});

describe("cross-server transfer commands", () => {
  function env(
    serviceType: "docker" | "systemd" | "kubernetes",
    dbType: "postgres" | "mssql" = "postgres"
  ): CommandTargetEnvironment {
    return {
      id: "env-1",
      services: [
        {
          role: "db",
          serviceType,
          serviceName: "db-svc",
          dbType,
          dbName: "car2",
          dbBackupPath: "/backups",
          server: { host: "10.0.0.1", username: "ops", password: "s3cr3t" },
        },
      ],
    };
  }

  describe("buildExtractCommand", () => {
    it("redirects to the SSH-owned temp OUTSIDE the db-shell wrapper", () => {
      // The redirect has to run in the outer SSH-user shell, or the temp lands
      // inside the container / owned by the DB user and SFTP can't read it.
      const cmd = buildExtractCommand(
        env("docker"),
        "/backups/x.sql",
        "/tmp/x"
      );
      expect(cmd.endsWith(" > '/tmp/x'")).toBe(true);
      expect(cmd).toContain("docker exec");
    });

    it("cats the file as the engine's OS user on systemd", () => {
      // The inner `cat` is itself quoted for `bash -c`, so the path shows up
      // double-escaped ('\''…'\''). That nesting is the contract, not noise.
      expect(
        buildExtractCommand(env("systemd", "mssql"), "/backups/x.bak", "/tmp/x")
      ).toBe(
        "printf '%s\\n' 's3cr3t' | sudo -S -u 'mssql' bash -c 'cat '\\''/backups/x.bak'\\''' > '/tmp/x'"
      );
    });

    it("survives a hostile source path through both quoting layers", () => {
      // A path carrying `'; rm -rf /` has to be neutralised twice: once for
      // the inner `bash -c` string, once for the outer SSH command line. The
      // metacharacters end up inert at both levels.
      expect(
        buildExtractCommand(env("docker"), "/backups/a'; rm -rf /", "/tmp/x")
      ).toBe(
        "docker exec 'db-svc' bash -c 'cat '\\''/backups/a'\\''\\'\\'''\\''; rm -rf /'\\''' > '/tmp/x'"
      );
    });
  });

  describe("buildPlaceCommand", () => {
    it("uses docker cp then fixes the mode", () => {
      const cmd = buildPlaceCommand(env("docker"), "/tmp/x", "/backups/x.sql");
      expect(cmd).toContain("docker cp '/tmp/x' 'db-svc:/backups/x.sql'");
      expect(cmd).toContain("docker exec 'db-svc' chmod 644 '/backups/x.sql'");
    });

    it("streams through exec -i on kubernetes rather than kubectl cp", () => {
      // `kubectl cp` needs a pod name; the app only knows the deployment.
      const cmd = buildPlaceCommand(
        env("kubernetes"),
        "/tmp/x",
        "/backups/x.sql"
      );
      expect(cmd).toContain("kubectl exec -i deploy/'db-svc' -- bash -c");
      expect(cmd).toContain("< '/tmp/x'");
      expect(cmd).not.toContain("kubectl cp");
    });

    it("chowns to the engine's OS user on systemd", () => {
      const cmd = buildPlaceCommand(
        env("systemd", "mssql"),
        "/tmp/x",
        "/backups/x.bak"
      );
      // Without the chown the file lands root-owned and the mssql process
      // can't read the backup it is being asked to restore.
      expect(cmd).toContain("chown mssql:mssql ");
      expect(cmd).toContain("chmod 644 ");
      expect(cmd).toContain("cp '\\''/tmp/x'\\''");
    });

    it("feeds the sudo password on stdin, never as an argument", () => {
      // An argument would land in the remote host's process list.
      const cmd = buildPlaceCommand(env("systemd"), "/tmp/x", "/backups/x.sql");
      expect(cmd.startsWith("printf '%s\\n' 's3cr3t' | sudo -S ")).toBe(true);
    });

    it("chains with && so a failed copy doesn't get reported as success", () => {
      expect(buildPlaceCommand(env("docker"), "/tmp/x", "/b/x")).toContain(
        " && "
      );
      expect(buildPlaceCommand(env("kubernetes"), "/tmp/x", "/b/x")).toContain(
        " && "
      );
    });
  });

  describe("buildRemovePlacedCommand", () => {
    it("removes the staged file inside the container on docker", () => {
      expect(buildRemovePlacedCommand(env("docker"), "/backups/x.sql")).toBe(
        "docker exec 'db-svc' rm -f '/backups/x.sql'"
      );
    });

    it("removes via exec on kubernetes", () => {
      expect(buildRemovePlacedCommand(env("kubernetes"), "/b/x")).toBe(
        "kubectl exec deploy/'db-svc' -- rm -f '/b/x'"
      );
    });

    it("removes under sudo on systemd", () => {
      expect(buildRemovePlacedCommand(env("systemd"), "/b/x")).toBe(
        "printf '%s\\n' 's3cr3t' | sudo -S rm -f '/b/x'"
      );
    });

    it("uses rm -f so a missing file isn't a failure", () => {
      for (const type of ["docker", "kubernetes", "systemd"] as const) {
        expect(buildRemovePlacedCommand(env(type), "/b/x")).toContain("rm -f");
      }
    });

    it("quotes a hostile destination path", () => {
      const cmd = buildRemovePlacedCommand(env("systemd"), "/b/x'; reboot; #");
      expect(cmd).toContain(`'/b/x'\\''; reboot; #'`);
    });
  });
});
