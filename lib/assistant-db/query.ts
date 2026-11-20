import type { ServiceWithServer } from "@/lib/db/schema";
import { loadEnvironmentWithServers } from "@/lib/environments";
import { mysqlStdinCommand, sqlcmdStdinCommand } from "@/lib/jobs/commands";
import { RemoteCommandError } from "@/lib/remote-command-error";
import { buildDbShellCommand } from "@/lib/services";
import { shq } from "@/lib/sh";
import { executeRemoteCommand, redactSecrets } from "@/lib/ssh";
import { sshTarget } from "@/lib/ssh-connect";
import type { AssistantDbLogin } from "./login";
import type { Cell } from "./mask";
import { ASSISTANT_DB_PGOPTIONS } from "./provision";
import { redactEngineError } from "./redact";

// Runs SQL the gate accepted (or the tool's own schema query) as the
// environment's dedicated read-only login, never the admin account (Stage 9
// spec F.2): SSH into the database service, the engine CLI with the SQL as
// one non-interactive argument (`psql -c`, `sqlcmd -Q`, `mysql -e`), a row
// cap and a 10 s timeout per engine, and a machine-readable output mode:
// - Postgres: `PGOPTIONS` forces read-only and the timeout for the session
//   (the role could change its own defaults); the query is wrapped in
//   `SELECT * FROM (…) LIMIT n`; CSV output with a NULL marker.
// - SQL Server: `-x` (no `$(var)` substitution), `-I` (QUOTED_IDENTIFIER
//   ON), `-t 10`, `SET ROWCOUNT`, cells split on a unit separator.
// - MySQL/MariaDB: the timeout set per session (MAX_EXECUTION_TIME or
//   MariaDB's max_statement_time), ANSI_QUOTES off, `sql_select_limit`, XML
//   output.
// The quoting the engine applies must be the one the gate, the masking and
// the activity redaction (`redactLiterals`) assume: on SQL Server a double
// quote names an identifier (ODBC sqlcmd defaults QUOTED_IDENTIFIER to OFF,
// which would make `"…"` a string literal that the redaction keeps; go-sqlcmd
// always has it on and accepts `-I` for compatibility); on MySQL/MariaDB it
// delimits a string (ANSI_QUOTES, which the server's sql_mode may set, would
// make it an identifier the parser takes for a literal and the masking
// misses), so the session clears ANSI_QUOTES and the ANSI combination.
// The MSSQL/MySQL password travels on stdin only.

/** The engine's own wait for one statement. */
export const QUERY_TIMEOUT_SECONDS = 10;
/** The SSH command's wall clock: connect, run, return. */
const SSH_TIMEOUT_MS = 30_000;
/** Most error text passed back. */
const MAX_ERROR_CHARS = 1000;

/** psql prints NULL as this (unquoted), so it differs from an empty string. */
const PG_NULL = "\u0001";
/** sqlcmd's column separator: a character data almost never holds. */
const MSSQL_SEPARATOR = "\u001f";

export type QueryResult = { columns: string[]; rows: Cell[][] };

/** The database refused or failed the query; `message` is safe to show. */
export class AssistantDbQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssistantDbQueryError";
  }
}

type DbService = Pick<ServiceWithServer, "serviceType" | "serviceName"> & {
  server: ServiceWithServer["server"];
};

/**
 * Clears ANSI_QUOTES (and the ANSI combination that implies it) from the
 * session's sql_mode, keeping every other mode: a double quote then delimits
 * a string, as the gate and the redaction read it.
 */
const MYSQL_NO_ANSI_QUOTES =
  "SET SESSION sql_mode = TRIM(BOTH ',' FROM REPLACE(REPLACE(CONCAT(',', @@SESSION.sql_mode, ','), ',ANSI_QUOTES,', ','), ',ANSI,', ','))";

/** The SQL as sent: the row cap (and MySQL's timeout) around the query. */
export function cappedSql(
  engine: AssistantDbLogin["engine"],
  sql: string,
  rowLimit: number
): string {
  switch (engine) {
    case "postgres":
      return `SELECT * FROM (${sql}) AS menara_q LIMIT ${rowLimit}`;
    case "mssql":
      return `SET NOCOUNT ON; SET ROWCOUNT ${rowLimit}; ${sql}`;
    case "mysql":
      // MySQL and MariaDB name the session timeout differently, and setting
      // the other's variable fails; only a prepared SET can pick at run time.
      return [
        `SET @menara_timeout = IF(VERSION() LIKE '%MariaDB%', 'SET SESSION max_statement_time = ${QUERY_TIMEOUT_SECONDS}', 'SET SESSION max_execution_time = ${QUERY_TIMEOUT_SECONDS * 1000}')`,
        "PREPARE menara_timeout FROM @menara_timeout",
        "EXECUTE menara_timeout",
        "DEALLOCATE PREPARE menara_timeout",
        MYSQL_NO_ANSI_QUOTES,
        `SET SESSION sql_select_limit = ${rowLimit}`,
        sql,
      ].join("; ");
  }
}

/** The remote command (and its stdin) that runs `sql` as the login. */
export function assistantQueryCommand(
  login: AssistantDbLogin,
  service: DbService,
  sql: string,
  rowLimit: number
): { command: string; stdin?: string } {
  const text = cappedSql(login.engine, sql, rowLimit);
  if (login.engine === "postgres") {
    const psql =
      `PGOPTIONS=${shq(ASSISTANT_DB_PGOPTIONS)} ` +
      `psql -X -q --csv -P ${shq(`null=${PG_NULL}`)} -v ON_ERROR_STOP=1`;
    const target = `-U ${shq(login.login)} -d ${shq(login.database)} -c ${shq(text)}`;
    // Postgres on systemd: the role logs in over 127.0.0.1 with its password
    // (the only stdin content), as the SSH user: no sudo, no peer auth.
    if (service.serviceType === "systemd") {
      if (!login.password) {
        throw new Error("Assistant database login has no password");
      }
      return {
        command: buildDbShellCommand(
          "systemd",
          service.serviceName,
          `IFS= read -r PGPASSWORD; export PGPASSWORD; ${psql} -h 127.0.0.1 ${target}`
        ),
        stdin: `${login.password}\n`,
      };
    }
    const inner = `${psql} ${target}`;
    // As postgres on systemd (peer auth); inside a container the exec lands
    // on the trusted local socket. -U makes the session the read-only role.
    return {
      command: buildDbShellCommand(
        service.serviceType,
        service.serviceName,
        inner,
        { runAsUser: "postgres", server: service.server }
      ),
    };
  }
  const stdin = `${login.password ?? ""}\n`;
  if (login.engine === "mssql") {
    return {
      command: sqlcmdStdinCommand(
        login.login,
        service.serviceType,
        service.serviceName,
        [
          "-d",
          login.database,
          "-x",
          "-I",
          "-t",
          String(QUERY_TIMEOUT_SECONDS),
          "-W",
          "-s",
          MSSQL_SEPARATOR,
          "-Q",
          text,
        ]
      ),
      stdin,
    };
  }
  return {
    command: mysqlStdinCommand(
      login.login,
      service.serviceType,
      service.serviceName,
      ["--xml", "--default-character-set=utf8mb4", "-e", text, login.database]
    ),
    stdin,
  };
}

// --- output parsers -----------------------------------------------------------------

/** psql --csv: RFC 4180 with a header; an unquoted PG_NULL field is NULL. */
export function parsePsqlCsv(stdout: string): QueryResult {
  const records: Cell[][] = [];
  let record: Cell[] = [];
  let field = "";
  let quoted = false;
  let inQuotes = false;
  let started = false;
  const endField = () => {
    record.push(!quoted && field === PG_NULL ? null : field);
    field = "";
    quoted = false;
  };
  for (let i = 0; i < stdout.length; i++) {
    const c = stdout[i] as string;
    started = true;
    if (inQuotes) {
      if (c === '"') {
        if (stdout[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      quoted = true;
    } else if (c === ",") {
      endField();
    } else if (c === "\n") {
      endField();
      records.push(record);
      record = [];
      started = false;
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (started) {
    endField();
    records.push(record);
  }
  const [header, ...rows] = records;
  return {
    columns: (header ?? []).map((name) => name ?? ""),
    rows,
  };
}

/**
 * sqlcmd -W -s US: a header line, a dashes line, then one line per row. A
 * cell holding a line break continues on the next line, so a row is
 * complete once it has as many separators as the header. sqlcmd prints
 * NULL as `NULL` (indistinguishable from the string 'NULL').
 */
export function parseSqlcmd(stdout: string): QueryResult {
  const lines = stdout.replace(/\r\n/g, "\n").split("\n");
  const headerIndex = lines.findIndex((line) => line.trim() !== "");
  if (headerIndex < 0) return { columns: [], rows: [] };
  const columns = (lines[headerIndex] as string).split(MSSQL_SEPARATOR);
  const width = columns.length;
  const rows: Cell[][] = [];
  let pending: string | null = null;
  const separators = (text: string) => text.split(MSSQL_SEPARATOR).length - 1;
  const body = lines.slice(headerIndex + 2);
  while (body.length > 0 && (body[body.length - 1] as string).trim() === "") {
    body.pop();
  }
  for (const line of body) {
    pending = pending === null ? line : `${pending}\n${line}`;
    if (separators(pending) < width - 1) continue;
    rows.push(
      pending
        .split(MSSQL_SEPARATOR)
        .map((cell) => (cell === "NULL" ? null : cell))
    );
    pending = null;
  }
  // A row cut short (a separator inside a cell would do it) is kept as is.
  if (pending !== null) rows.push(pending.split(MSSQL_SEPARATOR));
  return { columns, rows };
}

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity) => {
    const name = String(entity);
    if (name.startsWith("#x") || name.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    }
    if (name.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    }
    return XML_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * mysql --xml: `<row>` elements of `<field name="…">value</field>`, NULL as
 * `xsi:nil="true"`. Without rows there are no column names either.
 */
export function parseMysqlXml(stdout: string): QueryResult {
  const columns: string[] = [];
  const rows: Cell[][] = [];
  const field =
    /<field name="([^"]*)"(\s+xsi:nil="true")?\s*(?:\/>|>([\s\S]*?)<\/field>)/g;
  for (const row of stdout.matchAll(/<row>([\s\S]*?)<\/row>/g)) {
    const cells: Cell[] = [];
    const names: string[] = [];
    for (const match of (row[1] ?? "").matchAll(field)) {
      names.push(decodeXml(match[1] ?? ""));
      cells.push(match[2] ? null : decodeXml(match[3] ?? ""));
    }
    if (columns.length === 0) columns.push(...names);
    rows.push(cells);
  }
  return { columns, rows };
}

export function parseQueryOutput(
  engine: AssistantDbLogin["engine"],
  stdout: string
): QueryResult {
  switch (engine) {
    case "postgres":
      return parsePsqlCsv(stdout);
    case "mssql":
      return parseSqlcmd(stdout);
    case "mysql":
      return parseMysqlXml(stdout);
  }
}

// --- runner --------------------------------------------------------------------------

async function loadDbService(
  environmentId: string,
  serviceId: string
): Promise<DbService | null> {
  const environment = await loadEnvironmentWithServers(environmentId);
  return environment?.services.find((s) => s.id === serviceId) ?? null;
}

/**
 * Runs `sql` as the environment's read-only login with at most `rowLimit`
 * rows. Throws AssistantDbQueryError with the engine's (redacted, cut)
 * message when the database refuses or the command fails.
 */
export async function runAssistantDbQuery(
  environmentId: string,
  login: AssistantDbLogin,
  sql: string,
  rowLimit: number
): Promise<QueryResult> {
  const service = await loadDbService(environmentId, login.serviceId);
  if (!service) {
    throw new AssistantDbQueryError("The database service is not registered.");
  }
  const { command, stdin } = assistantQueryCommand(
    login,
    service,
    sql,
    rowLimit
  );
  const secrets = [login.password, service.server.password].filter(
    (s): s is string => Boolean(s)
  );
  let stdout: string;
  try {
    stdout = await executeRemoteCommand(sshTarget(service.server), command, {
      timeoutMs: SSH_TIMEOUT_MS,
      secrets,
      // Engine errors can echo values (e.g. a failed conversion): out
      // before the error is logged or thrown.
      redact: redactEngineError,
      ...(stdin === undefined ? {} : { stdin }),
    });
  } catch (error) {
    const detail =
      error instanceof RemoteCommandError
        ? error.stderr.trim() || error.stdout.trim()
        : error instanceof Error
          ? error.message
          : String(error);
    const message = redactEngineError(redactSecrets(detail, secrets)).slice(
      0,
      MAX_ERROR_CHARS
    );
    throw new AssistantDbQueryError(message || "The query failed.");
  }
  return parseQueryOutput(login.engine, stdout);
}
