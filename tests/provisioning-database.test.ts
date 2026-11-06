import { createHash, createHmac, pbkdf2Sync } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Shared database provisioning: the Panel computes the SCRAM-SHA-256 verifier
// itself, so Postgres never receives the plaintext password, and the SQL
// (verifier included) travels on psql's stdin, never in argv. A failure
// message must not carry the password or the verifier either.

type ExecCall = { command: string; stdin?: string };
const ssh = vi.hoisted(() => ({
  calls: [] as ExecCall[],
  result: { code: 0, stdout: "", stderr: "" } as {
    code: number;
    stdout: string;
    stderr: string;
  },
  // Lets a test build stderr from the SQL it received (psql echoing it).
  onExec: null as null | ((call: ExecCall) => void),
}));

vi.mock("node-ssh", () => ({
  NodeSSH: class {
    async connect() {}
    async execCommand(command: string, options?: { stdin?: string }) {
      const call = { command, stdin: options?.stdin };
      ssh.calls.push(call);
      ssh.onExec?.(call);
      return ssh.result;
    }
    dispose() {}
  },
}));

const {
  allowedBackupFilename,
  allowedDatabaseName,
  pgProvisionDatabaseSql,
  provisionSharedDatabase,
  redactSecrets,
  scramSha256Verifier,
  sharedDatabaseNameSchema,
} = await import("@/lib/provisioning/database");
const { executeRemoteCommand } = await import("@/lib/ssh");
const { pgSharedBackupPipeline, pgSharedRestorePipeline } = await import(
  "@/lib/jobs/commands"
);

const SALT = Uint8Array.from({ length: 16 }, (_, i) => i);
const VERIFIER_FORMAT =
  /^SCRAM-SHA-256\$4096:AAECAwQFBgcICQoLDA0ODw==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/;

describe("scramSha256Verifier", () => {
  it("has the RFC 5803 format Postgres stores", () => {
    const verifier = scramSha256Verifier("s3cret", {
      salt: SALT,
      iterations: 4096,
    });
    expect(verifier).toMatch(VERIFIER_FORMAT);
    const [, keys] = verifier.split("$").slice(1);
    expect(keys?.split(":").map((k) => k.length)).toEqual([44, 44]);
  });

  it("derives StoredKey and ServerKey per RFC 7677", () => {
    const verifier = scramSha256Verifier("s3cret", { salt: SALT });
    const salted = pbkdf2Sync("s3cret", Buffer.from(SALT), 4096, 32, "sha256");
    const clientKey = createHmac("sha256", salted)
      .update("Client Key")
      .digest();
    const storedKey = createHash("sha256").update(clientKey).digest("base64");
    const serverKey = createHmac("sha256", salted)
      .update("Server Key")
      .digest("base64");
    expect(verifier).toBe(
      `SCRAM-SHA-256$4096:${Buffer.from(SALT).toString("base64")}$${storedKey}:${serverKey}`
    );
  });

  it("defaults to 4096 iterations and a fresh 16-byte salt", () => {
    const a = scramSha256Verifier("s3cret");
    const b = scramSha256Verifier("s3cret");
    expect(a).not.toBe(b);
    for (const v of [a, b]) {
      const salt = v.split("$")[1]?.split(":")[1] ?? "";
      expect(v.startsWith("SCRAM-SHA-256$4096:")).toBe(true);
      expect(Buffer.from(salt, "base64")).toHaveLength(16);
    }
  });
});

describe("pgProvisionDatabaseSql", () => {
  const verifier = scramSha256Verifier("plain-password-1", { salt: SALT });
  const sql = pgProvisionDatabaseSql({
    database: "pcan_sandbox1",
    role: 'x"y',
    verifier,
  });

  it("starts with ON_ERROR_STOP and creates through \\gexec", () => {
    expect(sql.startsWith("\\set ON_ERROR_STOP on\n")).toBe(true);
    expect(sql).toContain("\\gexec");
  });

  it("holds the verifier, never the plaintext password", () => {
    expect(sql).not.toContain("plain-password-1");
    expect(sql).toContain(`PASSWORD '${verifier}';`);
  });

  it("quotes identifiers and literals", () => {
    expect(sql).toContain('ALTER ROLE "x""y" WITH LOGIN PASSWORD');
    expect(sql).toContain("rolname = 'x\"y'");
    // Inside the \gexec literal the identifier quoting survives intact.
    expect(sql).toContain(`'CREATE DATABASE "pcan_sandbox1" OWNER "x""y";'`);
  });

  it("ends every statement with a semicolon", () => {
    const lines = sql.split("\n").filter(Boolean);
    // Plain statements end with ";". A \gexec query is terminated by \gexec
    // (a ";" would send it once more); the statement it generates ends with
    // ";" inside its literal.
    for (const line of lines.filter((l) => /^(ALTER|REVOKE)/.test(l))) {
      expect(line).toMatch(/;$/);
    }
    const gexec = lines.filter((l) => l.endsWith("\\gexec"));
    expect(gexec).toHaveLength(2);
    for (const line of gexec) expect(line).toMatch(/^SELECT '[^']+;'/);
    // The multi-line DO guard ends with "END';".
    expect(sql).toMatch(/\nEND';\n/);
  });

  it("refuses another owner's database before touching the role", () => {
    const guard = sql.indexOf("database % exists with owner %");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(sql.indexOf("ALTER ROLE"));
    expect(guard).toBeLessThan(sql.indexOf("CREATE ROLE"));
  });
});

describe("provisionSharedDatabase", () => {
  const server = { host: "10.0.0.5", username: "ops", password: "ssh-pw" };
  const input = {
    database: "pcan_sandbox1",
    role: "pcan_sandbox1",
    password: "Very$ecret-pw",
  };
  let logged: unknown[][];

  beforeEach(() => {
    ssh.calls = [];
    ssh.result = { code: 0, stdout: "", stderr: "" };
    ssh.onExec = null;
    logged = [];
    vi.spyOn(console, "error").mockImplementation((...args) => {
      logged.push(args);
    });
  });

  const verifierOf = (stdin: string | undefined) =>
    /PASSWORD '(SCRAM-SHA-256\$[^']+)'/.exec(stdin ?? "")?.[1] ?? "";

  it("sends the SQL on stdin and keeps secrets out of argv", async () => {
    await provisionSharedDatabase(
      { server, containerName: "dplk-postgres" },
      input
    );
    const [call] = ssh.calls;
    expect(call?.command).toBe(
      "docker exec -i 'dplk-postgres' psql -U postgres -X -q -v ON_ERROR_STOP=1"
    );
    const verifier = verifierOf(call?.stdin);
    expect(verifier).toMatch(/^SCRAM-SHA-256\$4096:/);
    expect(call?.stdin).not.toContain(input.password);
    expect(call?.command).not.toContain(input.password);
    expect(call?.command).not.toContain(verifier);
  });

  it("redacts a verifier that psql echoes on failure", async () => {
    ssh.onExec = (call) => {
      const verifier = verifierOf(call.stdin);
      ssh.result = {
        code: 3,
        stdout: "",
        stderr: `ERROR:  syntax error\nLINE 1: ALTER ROLE "pcan_sandbox1" WITH LOGIN PASSWORD '${verifier}';\npassword ${input.password}`,
      };
    };
    const error = await provisionSharedDatabase(
      { server, containerName: "dplk-postgres" },
      input
    ).then(
      () => null,
      (e: Error) => e
    );
    const verifier = verifierOf(ssh.calls[0]?.stdin);
    expect(error?.message).toContain("syntax error");
    expect(error?.message).toContain("[redacted]");
    expect(error?.message).not.toContain(verifier);
    expect(error?.message).not.toContain(input.password);
    // Nor does the Panel log.
    const log = JSON.stringify(logged.map((a) => a.map(String)));
    expect(log).not.toContain(verifier);
    expect(log).not.toContain(input.password);
  });

  it("then checks the role reaches its database over the local socket", async () => {
    await provisionSharedDatabase(
      { server, containerName: "dplk-postgres" },
      input
    );
    expect(ssh.calls[1]?.command).toBe(
      "docker exec 'dplk-postgres' psql -X -U 'pcan_sandbox1' -d 'pcan_sandbox1' -Atc 'select 1'"
    );
    expect(ssh.calls[1]?.stdin).toBeUndefined();
  });

  it("fails clearly when the role can't connect (pg_hba not trusting local)", async () => {
    let n = 0;
    ssh.onExec = () => {
      n++;
      ssh.result =
        n === 2
          ? {
              code: 2,
              stdout: "",
              stderr:
                'FATAL:  password authentication failed for user "pcan_sandbox1"',
            }
          : { code: 0, stdout: "", stderr: "" };
    };
    await expect(
      provisionSharedDatabase({ server, containerName: "dplk-postgres" }, input)
    ).rejects.toThrow(/pg_hba must trust local connections/);
  });

  it("refuses a non-ASCII password before touching the server", async () => {
    for (const password of ["pässwort", "pw\n", "pw\u00a0x", ""]) {
      await expect(
        provisionSharedDatabase(
          { server, containerName: "dplk-postgres" },
          { ...input, password }
        )
      ).rejects.toThrow(/printable ASCII/);
    }
    expect(ssh.calls).toEqual([]);
  });
});

describe("executeRemoteCommand options", () => {
  beforeEach(() => {
    ssh.calls = [];
    ssh.result = { code: 0, stdout: "ok", stderr: "" };
    ssh.onExec = null;
  });

  it("keeps the positional timeout and sends no stdin by default", async () => {
    const creds = { host: "h", username: "u", password: "p" };
    expect(await executeRemoteCommand(creds, "true", 30_000)).toBe("ok");
    expect(await executeRemoteCommand(creds, "true")).toBe("ok");
    expect(ssh.calls.map((c) => c.stdin)).toEqual([undefined, undefined]);
  });
});

describe("redactSecrets", () => {
  it("also removes any SCRAM verifier, whole or cut off", () => {
    expect(
      redactSecrets(
        "LINE 1: ALTER ROLE x PASSWORD 'SCRAM-SHA-256$4096:AAEC' and SCRAM-SHA-256$40",
        []
      )
    ).toBe("LINE 1: ALTER ROLE x PASSWORD '[redacted]' and [redacted]");
  });

  it("replaces every occurrence, longest secret first, ignoring empty ones", () => {
    expect(redactSecrets("a abc abc b", ["", "ab", "abc"])).toBe(
      "a [redacted] [redacted] b"
    );
  });
});

describe("sharedDatabaseNameSchema", () => {
  it("accepts plain lowercase identifiers up to 63 characters", () => {
    for (const ok of ["pcan_sandbox1", "a", `a${"b".repeat(62)}`]) {
      expect(sharedDatabaseNameSchema.safeParse(ok).success).toBe(true);
    }
    for (const bad of [
      "",
      "1a",
      "_a",
      "Pcan",
      "a-b",
      'x"y',
      `a${"b".repeat(63)}`,
    ]) {
      expect(sharedDatabaseNameSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("allowedDatabaseName / allowedBackupFilename", () => {
  const shared = { dbKind: "shared" as const, dbName: "pcan_sandbox1" };

  it("confines a shared binding for a caller without server:manage", () => {
    expect(allowedDatabaseName(shared, "pcan_sandbox1", false)).toBe(true);
    // Only the binding's own database: no `<dbName>_…` copies.
    expect(allowedDatabaseName(shared, "pcan_sandbox1_copy", false)).toBe(
      false
    );
    expect(allowedDatabaseName(shared, "pcan_sandbox10", false)).toBe(false);
    expect(allowedDatabaseName(shared, "hris_dss", false)).toBe(false);
    expect(
      allowedBackupFilename(shared, "pcan_sandbox1_2026-11-05.sql.gz", false)
    ).toBe(true);
    expect(allowedBackupFilename(shared, "hris_dss_2026.sql.gz", false)).toBe(
      false
    );
  });

  it("leaves server:manage callers and other kinds unrestricted", () => {
    expect(allowedDatabaseName(shared, "hris_dss", true)).toBe(true);
    for (const dbKind of [null, "container", "external"] as const) {
      const binding = { dbKind, dbName: "app" };
      expect(allowedDatabaseName(binding, "hris_dss", false)).toBe(true);
      expect(allowedBackupFilename(binding, "hris_dss_1.sql", false)).toBe(
        true
      );
    }
  });
});

// Runs the generated SQL against the local scratch cluster (a restored copy
// of the Panel DB in the opsdeck-postgres container) and logs in as the role.
// 127.0.0.1 is `trust` in that container's pg_hba, so the login goes to the
// container's own network address, which hits `host all all all
// scram-sha-256`. Everything it creates is named pcan_it_* and dropped.
const scratch = process.env.PROVISION_SCRATCH_URL;
describe.skipIf(!scratch)("shared database SQL on a scratch Postgres", () => {
  const CONTAINER = "opsdeck-postgres";
  const DB = "pcan_it_db";
  const ROLE = "pcan_it_role";
  const OTHER_ROLE = "pcan_it_other";
  const OWNED = "pcan_it_owned";
  let address = "";

  async function run(args: string[], stdin?: string) {
    const proc = Bun.spawn(["podman", ...args], {
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout: stdout.trim(), stderr: stderr.trim() };
  }
  const GRANTS_DB = "pcan_it_grants";
  const NEW_DB = "pcan_it_new";
  const GRANTED = "pcan_it_granted";
  const MEMBER = "pcan_it_member";
  const GROUP = "pcan_it_group";
  const DUMP = "/tmp/pcan_it_dump.sql.gz";
  const provision = (database: string, password: string, role = ROLE) =>
    run(
      [
        "exec",
        "-i",
        CONTAINER,
        "psql",
        "-U",
        "postgres",
        "-d",
        "provision_scratch",
        "-X",
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      pgProvisionDatabaseSql({
        database,
        role,
        verifier: scramSha256Verifier(password),
      })
    );
  const superuser = (sql: string) =>
    run([
      "exec",
      CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      "provision_scratch",
      "-X",
      "-Atc",
      sql,
    ]);
  const login = (password: string, database = DB) =>
    run([
      "exec",
      "-e",
      `PGPASSWORD=${password}`,
      CONTAINER,
      "psql",
      "-h",
      address,
      "-U",
      ROLE,
      "-d",
      database,
      "-X",
      "-Atc",
      "select current_user || ' ' || current_database()",
    ]);
  const cleanup = async () => {
    for (const db of [DB, OWNED, GRANTS_DB, NEW_DB, `${DB}_second`]) {
      await superuser(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    }
    for (const role of [ROLE, OTHER_ROLE, GRANTED, MEMBER, GROUP]) {
      await superuser(`DROP ROLE IF EXISTS ${role}`);
    }
    await run(["exec", CONTAINER, "sh", "-c", "rm -f /tmp/pcan_it_*"]);
  };
  // As the binding's role over the container's local socket, as the shared
  // backup and restore pipelines connect.
  const asRole = (sql: string) =>
    run([
      "exec",
      CONTAINER,
      "psql",
      "-X",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      ROLE,
      "-d",
      DB,
      "-Atc",
      sql,
    ]);
  const shell = (script: string) =>
    run(["exec", CONTAINER, "bash", "-c", script]);
  const passwordOf = async (role: string) =>
    (
      await superuser(
        `SELECT rolpassword FROM pg_authid WHERE rolname = '${role}'`
      )
    ).stdout;

  beforeAll(async () => {
    address = (await run(["exec", CONTAINER, "hostname", "-i"])).stdout
      .split(/\s+/)
      .find((a) => a && a !== "127.0.0.1" && !a.includes(":")) as string;
    expect(address).toBeTruthy();
    // The login must go through a scram-sha-256 line, not a trust one.
    const hba = await superuser(
      `SELECT auth_method FROM pg_hba_file_rules WHERE type = 'host' AND 'all' = ANY(database) AND address = 'all'`
    );
    expect(hba.stdout).toBe("scram-sha-256");
    await cleanup();
  });
  afterAll(cleanup);

  it("creates the role and database; the role logs in with the plaintext password", async () => {
    const created = await provision(DB, "first-Pw-1");
    expect(created).toMatchObject({ code: 0, stderr: "" });
    const stored = await superuser(
      `SELECT rolpassword LIKE 'SCRAM-SHA-256$4096:%', pg_get_userbyid(datdba) FROM pg_authid, pg_database WHERE rolname = '${ROLE}' AND datname = '${DB}'`
    );
    expect(stored.stdout).toBe(`t|${ROLE}`);
    expect(await login("first-Pw-1")).toMatchObject({
      code: 0,
      stdout: `${ROLE} ${DB}`,
    });
    expect((await login("wrong-password")).code).not.toBe(0);
  });

  it("is idempotent and changes the password on a rerun", async () => {
    const rerun = await provision(DB, "second-Pw-2");
    expect(rerun).toMatchObject({ code: 0, stderr: "" });
    expect((await login("second-Pw-2")).code).toBe(0);
    expect((await login("first-Pw-1")).code).not.toBe(0);
  });

  it("refuses a database another role owns, before changing the password", async () => {
    await superuser(`CREATE ROLE ${OTHER_ROLE} LOGIN`);
    await superuser(`CREATE DATABASE ${OWNED} OWNER ${OTHER_ROLE}`);
    const refused = await provision(OWNED, "third-Pw-3");
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain(
      `database ${OWNED} exists with owner ${OTHER_ROLE}`
    );
    expect(refused.stderr).not.toMatch(/SCRAM-SHA-256\$/);
    // Nothing ran after the guard: the old password still works.
    expect((await login("second-Pw-2")).code).toBe(0);
  });

  it("refuses a role that already owns another database", async () => {
    const refused = await provision(`${DB}_second`, "fourth-Pw-4");
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain(
      `role ${ROLE} is in use outside database ${DB}_second`
    );
    expect(
      (
        await superuser(
          `SELECT 1 FROM pg_database WHERE datname = '${DB}_second'`
        )
      ).stdout
    ).toBe("");
  });
  it("refuses an existing role with a grant on another database, password unchanged", async () => {
    await superuser(`CREATE DATABASE ${GRANTS_DB}`);
    await superuser(`CREATE ROLE ${GRANTED} LOGIN PASSWORD 'orig-Pw-0'`);
    await superuser(`GRANT CONNECT ON DATABASE ${GRANTS_DB} TO ${GRANTED}`);
    const before = await passwordOf(GRANTED);
    const refused = await provision(NEW_DB, "takeover-Pw-5", GRANTED);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain(
      `role ${GRANTED} is in use outside database ${NEW_DB}`
    );
    expect(await passwordOf(GRANTED)).toBe(before);
    expect(
      (await superuser(`SELECT 1 FROM pg_database WHERE datname = '${NEW_DB}'`))
        .stdout
    ).toBe("");
  });

  it("refuses an existing role that is a member of another role", async () => {
    await superuser(`CREATE ROLE ${GROUP} NOLOGIN`);
    await superuser(`CREATE ROLE ${MEMBER} NOLOGIN IN ROLE ${GROUP}`);
    const refused = await provision(NEW_DB, "takeover-Pw-6", MEMBER);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain(`role ${MEMBER} is in use outside`);
    expect(
      (
        await superuser(
          `SELECT rolcanlogin FROM pg_roles WHERE rolname = '${MEMBER}'`
        )
      ).stdout
    ).toBe("f");
  });

  it("backs up and restores as the role, so a hostile CHECK can't escalate", async () => {
    // What a maintainer holding the role's password could plant: a CHECK
    // whose function tries to make the role a superuser, swallowing the
    // error so the restore looks clean. Replayed as postgres, it would run
    // as postgres during COPY.
    const planted = await asRole(
      [
        `CREATE FUNCTION public.grab(x int) RETURNS boolean LANGUAGE plpgsql AS $f$ BEGIN BEGIN EXECUTE 'ALTER ROLE ${ROLE} SUPERUSER'; EXCEPTION WHEN others THEN NULL; END; RETURN true; END $f$`,
        "CREATE TABLE public.t (x int CHECK (public.grab(x)))",
        "INSERT INTO public.t SELECT generate_series(1, 5)",
      ].join("; ")
    );
    expect(planted).toMatchObject({ code: 0, stderr: "" });

    const backup = pgSharedBackupPipeline(DB, ROLE, DUMP, true);
    expect(backup).not.toContain("-U postgres");
    expect(await shell(backup)).toMatchObject({ code: 0 });

    await asRole("DELETE FROM public.t WHERE x > 2");
    const restore = pgSharedRestorePipeline(DB, ROLE, DUMP, true);
    expect(restore).not.toContain("-U postgres");
    const restored = await shell(restore);
    expect(restored).toMatchObject({ code: 0 });

    expect((await asRole("SELECT count(*) FROM public.t")).stdout).toBe("5");
    expect(
      (
        await superuser(
          `SELECT rolsuper FROM pg_roles WHERE rolname = '${ROLE}'`
        )
      ).stdout
    ).toBe("f");
    // The database itself was kept, not dropped and recreated.
    expect(
      (
        await superuser(
          `SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '${DB}'`
        )
      ).stdout
    ).toBe(ROLE);
  });

  it("refuses a restore whose dump is missing, without emptying the database", async () => {
    const restore = pgSharedRestorePipeline(
      DB,
      ROLE,
      "/tmp/pcan_it_missing.sql",
      false
    );
    expect((await shell(restore)).code).not.toBe(0);
    expect((await asRole("SELECT count(*) FROM public.t")).stdout).toBe("5");
  });
  it("a failed restore rolls back the reset: truncated .gz, or a failing last statement", async () => {
    const BIG = "/tmp/pcan_it_big.sql.gz";
    const CUT = "/tmp/pcan_it_cut.sql.gz";
    const BAD = "/tmp/pcan_it_bad.sql";
    const count = async () =>
      (await asRole("SELECT count(*) FROM public.pcan_it_rows")).stdout;
    expect(
      await asRole(
        "CREATE TABLE public.pcan_it_rows AS SELECT g AS id, md5(g::text) AS v FROM generate_series(1, 200000) g"
      )
    ).toMatchObject({ code: 0 });
    expect(
      await shell(pgSharedBackupPipeline(DB, ROLE, BIG, true))
    ).toMatchObject({ code: 0 });
    expect(await count()).toBe("200000");

    // A .gz cut short: refused before the database is touched.
    expect((await shell(`head -c 20000 ${BIG} > ${CUT}`)).code).toBe(0);
    const cut = await shell(pgSharedRestorePipeline(DB, ROLE, CUT, true));
    expect(cut.code).not.toBe(0);
    expect(await count()).toBe("200000");
    expect((await asRole("SELECT count(*) FROM public.t")).stdout).toBe("5");

    // A complete dump whose last statement fails: the whole session,
    // DROP OWNED included, rolls back.
    expect(
      (await shell(`gunzip -c ${BIG} > ${BAD} && echo 'SELECT 1/0;' >> ${BAD}`))
        .code
    ).toBe(0);
    const bad = await shell(pgSharedRestorePipeline(DB, ROLE, BAD, false));
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain("division by zero");
    expect(await count()).toBe("200000");
    expect((await asRole("SELECT count(*) FROM public.t")).stdout).toBe("5");

    // And the intact dump still restores.
    expect(
      await shell(pgSharedRestorePipeline(DB, ROLE, BIG, true))
    ).toMatchObject({ code: 0 });
    expect(await count()).toBe("200000");
  });
});
