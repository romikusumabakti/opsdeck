import { Parser as MysqlParser } from "node-sql-parser/build/mysql";
import { Parser as PostgresParser } from "node-sql-parser/build/postgresql";
import { Parser as TransactSqlParser } from "node-sql-parser/build/transactsql";
import type { DatabaseType } from "@/lib/services";
import { isSensitiveName } from "./mask";
import { sqlSegments } from "./redact";

// The gate in front of the Assistant's read-only database login (Stage 9
// spec F.2/F.3). It is the first of three barriers (then the login's grants,
// then its read-only and timeout settings): only one SELECT (or WITH …
// SELECT), parsed by a real SQL parser per engine, ever reaches the engine
// CLI; anything else is refused before it is sent.
//
// What is sent is the query text itself (on one line), not a re-rendering
// of the parse tree, so the engine runs exactly what was checked. For that
// to hold the text must lex the same way for the parser and the engine, so
// the characters where engines and parsers disagree are refused outright:
// comments (`--`, `/* */`, MySQL `#` and its executable `/*! */`),
// backslashes (escapes in MySQL and E'' strings, psql/mysql meta-commands),
// `$` on Postgres (dollar quotes, parameters), sqlcmd `$(var)`, and any `;`
// but a trailing one, so a CLI can never see a second statement. A literal
// may not span lines (CLI commands such as `!!` start a line); other line
// breaks become spaces.
//
// Masking support (best effort): a sensitive column (mask#isSensitiveName)
// may be selected plainly (its cells are masked by the result's column
// name), filtered on or counted; selecting it under another name or inside
// an expression is refused, so its values can't reach the model unmasked.

export type GateEngine = DatabaseType;

export type ResolvedColumn = {
  /** The result column's name: alias, else the column; null when unknown. */
  name: string | null;
  /** The columns the select item reads. */
  sources: string[];
  /** Masked: its name or a source is sensitive. */
  sensitive: boolean;
  /** `*` or `t.*`: its columns are only known from the result. */
  star: boolean;
};

export type GateRefusal =
  | "multiple"
  | "not_select"
  | "wrapped_sensitive"
  | "parse"
  // MySQL only: an explicit LIMIT above the row cap (MySQL's own row cap,
  // sql_select_limit, yields to an explicit LIMIT).
  | "limit";

export type GateResult =
  | { ok: true; normalized: string; outputColumns: ResolvedColumn[] }
  | { ok: false; reason: GateRefusal; message: string };

/** Longest query the gate parses. */
export const MAX_QUERY_CHARS = 20_000;
/** The row cap the tool enforces (MySQL's explicit LIMIT is checked here). */
export const GATE_ROW_LIMIT = 100;

const DIALECT: Record<GateEngine, string> = {
  postgres: "postgresql",
  mssql: "transactsql",
  mysql: "mysql",
};

type SqlParser = {
  astify(sql: string, opt?: { database?: string }): unknown;
};

const parsers = new Map<GateEngine, SqlParser>();
function parserFor(engine: GateEngine): SqlParser {
  let parser = parsers.get(engine);
  if (!parser) {
    parser =
      engine === "postgres"
        ? new PostgresParser()
        : engine === "mssql"
          ? new TransactSqlParser()
          : new MysqlParser();
    parsers.set(engine, parser);
  }
  return parser;
}

const refuse = (reason: GateRefusal, message: string): GateResult => ({
  ok: false,
  reason,
  message,
});

const ONE_SELECT =
  "Send exactly one read-only SELECT (or WITH … SELECT) statement.";

// --- lexical preconditions ------------------------------------------------------

function lexicalCheck(
  sql: string,
  engine: GateEngine
): { text: string } | GateResult {
  const trimmed = sql.replace(/[\s;]+$/, "").trim();
  if (!trimmed) return refuse("parse", `The query is empty. ${ONE_SELECT}`);
  if (trimmed.length > MAX_QUERY_CHARS) {
    return refuse(
      "parse",
      `The query is longer than ${MAX_QUERY_CHARS} characters.`
    );
  }
  if (trimmed.includes(";")) {
    return refuse(
      "multiple",
      `Only one statement can run per call, and ";" may only end it (also not inside a string). ${ONE_SELECT}`
    );
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) {
    return refuse("parse", "The query contains control characters.");
  }
  const banned: [string, string][] = [
    ["--", "comments"],
    ["/*", "comments"],
    ["*/", "comments"],
    ["\\", "backslashes"],
  ];
  if (engine === "mysql") banned.push(["#", "# comments"]);
  if (engine === "postgres") {
    banned.push(["$", "dollar quoting and $n parameters"]);
  }
  if (engine === "mssql") banned.push(["$(", "sqlcmd variables"]);
  for (const [needle, what] of banned) {
    if (trimmed.includes(needle)) {
      return refuse(
        "parse",
        `The query uses ${what}, which are not supported here (not even inside a string). Rewrite it without them.`
      );
    }
  }
  const segments = sqlSegments(trimmed, engine);
  if (
    segments.some(
      (s) =>
        (s.kind === "string" || s.kind === "identifier") &&
        /[\r\n]/.test(s.text)
    )
  ) {
    return refuse(
      "parse",
      "A string literal or quoted name spans more than one line; keep each on one line."
    );
  }
  return { text: trimmed.replace(/[\r\n\t]+/g, " ") };
}

// --- AST helpers ------------------------------------------------------------------

type Node = Record<string, unknown>;
const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Every object below `value` (depth first, `value` included). */
function* walk(value: unknown): Generator<Node> {
  if (Array.isArray(value)) {
    for (const item of value) yield* walk(item);
    return;
  }
  if (!isNode(value)) return;
  yield value;
  for (const [key, child] of Object.entries(value)) {
    // The parser's own summaries of a subquery, not part of the tree.
    if (key === "tableList" || key === "columnList") continue;
    yield* walk(child);
  }
}

const textOf = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (isNode(value)) {
    if (typeof value.value === "string") return value.value;
    if (isNode(value.expr)) return textOf(value.expr);
  }
  return null;
};

/** A column_ref's column name, or "*" for a star. */
const columnName = (ref: Node): string | null => textOf(ref.column);
const tableName = (ref: Node): string | null => textOf(ref.table);

/** The last part of a function's (possibly schema-qualified) name. */
function functionName(node: Node): string | null {
  if (typeof node.name === "string") return node.name.toLowerCase();
  if (isNode(node.name) && Array.isArray(node.name.name)) {
    const parts = node.name.name as unknown[];
    const last = textOf(parts[parts.length - 1]);
    return last?.toLowerCase() ?? null;
  }
  return null;
}

const STATEMENT_TYPES = new Set([
  "insert",
  "replace",
  "update",
  "delete",
  "create",
  "alter",
  "drop",
  "truncate",
  "rename",
  "use",
  "grant",
  "revoke",
  "set",
  "lock",
  "unlock",
  "call",
  "exec",
  "execute",
  "declare",
  "transaction",
  "show",
  "desc",
  "explain",
  "load_data",
  "copy",
  "merge",
  "upsert",
  "comment",
  "deallocate",
  "prepare",
  "go",
]);

// Postgres: pg_* admin functions are refused except these size/type helpers.
const PG_ALLOWED = new Set([
  "pg_size_pretty",
  "pg_total_relation_size",
  "pg_relation_size",
  "pg_table_size",
  "pg_indexes_size",
  "pg_typeof",
]);
const DENIED_FUNCTIONS = new Set([
  // Postgres: settings, sequences, dynamic SQL dumped as XML, other DBs.
  "set_config",
  "nextval",
  "setval",
  "query_to_xml",
  "query_to_xmlschema",
  "query_to_xml_and_xmlschema",
  "cursor_to_xml",
  "cursor_to_xmlschema",
  // SQL Server: other servers and files.
  "openrowset",
  "opendatasource",
  "openquery",
  "openxml",
  "fn_xe_file_target_read_file",
  "fn_get_audit_file",
  "fn_trace_gettable",
  "fn_dblog",
  "fn_dump_dblog",
  // MySQL/MariaDB: files, sleeps, locks.
  "load_file",
  "sleep",
  "benchmark",
  "get_lock",
  "release_lock",
  "release_all_locks",
  "is_free_lock",
  "is_used_lock",
  "master_pos_wait",
  "source_pos_wait",
  "wait_for_executed_gtid_set",
  "sys_exec",
  "sys_eval",
]);

function deniedFunction(name: string): boolean {
  if (DENIED_FUNCTIONS.has(name)) return true;
  if (name.startsWith("pg_")) return !PG_ALLOWED.has(name);
  return (
    name.startsWith("dblink") ||
    name.startsWith("lo_") ||
    name.startsWith("xp_") ||
    name.startsWith("sp_") ||
    // table_to_xml, schema_to_xml, database_to_xml…: whole tables as XML.
    name.includes("_to_xml")
  );
}

// SQL Server table hints that only relax locking.
const ALLOWED_TABLE_HINTS = new Set(["nolock", "readuncommitted", "nowait"]);

/** Operators that compare or combine conditions: their operands stay plain. */
const CONDITION_OPERATORS = new Set([
  "=",
  "!=",
  "<>",
  "<",
  ">",
  "<=",
  ">=",
  "<=>",
  "AND",
  "OR",
  "XOR",
  "NOT",
  "IS",
  "IS NOT",
  "IN",
  "NOT IN",
  "LIKE",
  "NOT LIKE",
  "ILIKE",
  "NOT ILIKE",
  "BETWEEN",
  "NOT BETWEEN",
  "EXISTS",
  "NOT EXISTS",
]);

/** A node that computes a new value from its operands. */
function wraps(node: Node): boolean {
  switch (node.type) {
    case "function":
      return functionName(node) !== "exists";
    case "aggr_func":
      return String(node.name).toUpperCase() !== "COUNT";
    case "cast":
    case "case":
    case "interval":
    case "unary_expr":
      return node.type !== "unary_expr" || node.operator !== "NOT";
    case "binary_expr":
      return !CONDITION_OPERATORS.has(String(node.operator).toUpperCase());
    default:
      return false;
  }
}

type Scope = { relations: Set<string> };

/** Sensitive column references and literals anywhere below `value`. */
function sensitiveRefs(value: unknown): string[] {
  const found: string[] = [];
  for (const node of walk(value)) {
    if (node.type === "column_ref") {
      const name = columnName(node);
      if (name && name !== "*" && isSensitiveName(name)) found.push(name);
    }
  }
  return found;
}

function sensitiveLiterals(value: unknown): string[] {
  const found: string[] = [];
  for (const node of walk(value)) {
    if (
      (node.type === "single_quote_string" ||
        node.type === "double_quote_string" ||
        node.type === "string") &&
      typeof node.value === "string" &&
      isSensitiveName(node.value)
    ) {
      found.push(node.value);
    }
  }
  return found;
}

const WRAPPED = (name: string) =>
  `Column ${name} may hold personal data or credentials: select it plainly (e.g. SELECT ${name} FROM …; its values are then masked), or filter on it in WHERE, but do not rename it, wrap it in an expression or function, or read it through a whole-row value.`;

/** The select nodes of the tree: every SELECT, its set-operation branches included. */
function selects(ast: unknown): Node[] {
  return [...walk(ast)].filter(
    (n) => n.type === "select" && Array.isArray(n.columns)
  );
}

/** The branches of a set operation (UNION/INTERSECT/EXCEPT), first one first. */
function branches(select: Node): Node[] {
  const out: Node[] = [];
  let current: unknown = select;
  while (isNode(current)) {
    out.push(current);
    current = current._next;
  }
  return out;
}

function resolveColumn(item: Node): ResolvedColumn {
  const expr = isNode(item.expr) ? item.expr : item;
  const alias = textOf(item.as);
  if (expr.type === "column_ref" && columnName(expr) === "*") {
    return { name: null, sources: [], sensitive: false, star: true };
  }
  const sources = [
    ...new Set(
      [...walk(expr)]
        .filter((n) => n.type === "column_ref")
        .map((n) => columnName(n))
        .filter((n): n is string => Boolean(n) && n !== "*")
    ),
  ];
  const name = alias ?? (expr.type === "column_ref" ? columnName(expr) : null);
  return {
    name,
    sources,
    sensitive:
      (name !== null && isSensitiveName(name)) || sources.some(isSensitiveName),
    star: false,
  };
}

/** Why a select item exposes a sensitive value unmasked, if it does. */
function itemLeak(item: Node): string | null {
  const expr = isNode(item.expr) ? item.expr : item;
  const alias = textOf(item.as);
  if (expr.type === "column_ref") {
    const name = columnName(expr);
    if (!name || name === "*") return null;
    if (isSensitiveName(name) && alias !== null && !isSensitiveName(alias)) {
      return name;
    }
    return null;
  }
  // count(email) reveals no value (anything it wraps is checked by `wraps`).
  if (
    expr.type === "aggr_func" &&
    String(expr.name).toUpperCase() === "COUNT"
  ) {
    return null;
  }
  const refs = sensitiveRefs(expr);
  if (refs.length > 0) return refs[0] as string;
  const literals = sensitiveLiterals(expr);
  if (literals.length > 0) return literals[0] as string;
  return null;
}

/** The relation names and aliases a query reads (whole-row references). */
function relationsOf(ast: unknown): Set<string> {
  const names = new Set<string>();
  for (const node of walk(ast)) {
    if (Array.isArray(node.from)) {
      for (const from of node.from) {
        if (!isNode(from)) continue;
        for (const key of ["table", "as"] as const) {
          const name = textOf(from[key]);
          if (name) names.add(name.toLowerCase());
        }
      }
    }
    if (Array.isArray(node.with)) {
      for (const cte of node.with) {
        const name = isNode(cte) ? textOf(cte.name) : null;
        if (name) names.add(name.toLowerCase());
      }
    }
  }
  return names;
}

function limitCount(select: Node): number | null {
  const limit = select.limit;
  if (!isNode(limit) || !Array.isArray(limit.value)) return null;
  const values = limit.value as unknown[];
  if (values.length === 0) return null;
  const count = limit.seperator === "," ? values[1] : values[0];
  return isNode(count) && typeof count.value === "number" ? count.value : null;
}

// --- the gate ------------------------------------------------------------------

function astCheck(
  ast: Node,
  engine: GateEngine
): { outputColumns: ResolvedColumn[] } | GateResult {
  const scope: Scope = { relations: relationsOf(ast) };
  // Stars that stand as a select item (SELECT *, SELECT t.*); any other star
  // passes a whole row to something (row_to_json(t.*)).
  const itemStars = new Set<Node>();
  for (const select of selects(ast)) {
    for (const item of select.columns as unknown[]) {
      const expr = isNode(item) && isNode(item.expr) ? item.expr : item;
      if (
        isNode(expr) &&
        expr.type === "column_ref" &&
        columnName(expr) === "*"
      ) {
        itemStars.add(expr);
      }
    }
  }
  for (const node of walk(ast)) {
    if (node.type === "column_ref") {
      const name = columnName(node);
      // A whole-row value (`m` of `FROM members m`) carries every column.
      const wholeRow =
        name === "*"
          ? !itemStars.has(node)
          : name !== null &&
            tableName(node) === null &&
            scope.relations.has(name.toLowerCase());
      if (wholeRow) {
        return refuse(
          "wrapped_sensitive",
          "A whole row (t.* or a table name) can only be selected as SELECT * or SELECT t.*; select the columns you need."
        );
      }
    }
    if (typeof node.type === "string" && STATEMENT_TYPES.has(node.type)) {
      return refuse(
        "not_select",
        `${node.type.toUpperCase()} is not allowed; ${ONE_SELECT}`
      );
    }
    if (node.type === "function" || node.type === "aggr_func") {
      const name = functionName(node);
      if (name && deniedFunction(name)) {
        return refuse(
          "not_select",
          `The function ${name} is not allowed (admin, file, lock, sequence or dynamic-SQL functions are refused).`
        );
      }
    }
    if (node.type === "var") {
      // @@version and the like are read-only; @x user variables and
      // Postgres $n parameters are not part of a single read.
      if (node.prefix !== "@@") {
        return refuse(
          "not_select",
          "Variables and parameters are not allowed."
        );
      }
    }
    if (isNode(node.into) && node.into.expr != null) {
      return refuse(
        "not_select",
        `SELECT … INTO writes data and is not allowed. ${ONE_SELECT}`
      );
    }
    if (node.locking_read) {
      return refuse(
        "not_select",
        `Locking clauses (${String(node.locking_read)}) are not allowed.`
      );
    }
    if (isNode(node.table_hint) && Array.isArray(node.table_hint.expr)) {
      for (const hint of node.table_hint.expr) {
        const value = isNode(hint) ? textOf(hint.expr) : null;
        if (!(value && ALLOWED_TABLE_HINTS.has(value.toLowerCase()))) {
          return refuse(
            "not_select",
            `The table hint ${value ?? "?"} is not allowed (only NOLOCK, READUNCOMMITTED, NOWAIT).`
          );
        }
      }
    }
    // `AS s(a, b)` renames a relation's columns.
    if (typeof node.as === "string" && node.as.includes("(")) {
      return refuse(
        "wrapped_sensitive",
        "Column alias lists on a table or subquery (AS s(a, b)) are not supported; alias each column in the select list instead."
      );
    }
    // A sensitive column inside a function, cast or computation, anywhere.
    if (wraps(node)) {
      const refs = sensitiveRefs(
        Object.fromEntries(
          Object.entries(node).filter(([key]) => key !== "over")
        )
      );
      if (refs.length > 0) {
        return refuse("wrapped_sensitive", WRAPPED(refs[0] as string));
      }
    }
    // `t.*` or a CTE column list that renames a star or a sensitive column.
    if (Array.isArray(node.with)) {
      for (const cte of node.with) {
        if (!(isNode(cte) && Array.isArray(cte.columns))) continue;
        if (cte.columns.length === 0) continue;
        const inner = cte.stmt;
        const items = selects(inner).flatMap((s) =>
          Array.isArray(s.columns) ? (s.columns as Node[]) : []
        );
        const renamed = items.find((item) => {
          const c = resolveColumn(item);
          return c.star || c.sources.some(isSensitiveName);
        });
        if (renamed) {
          return refuse(
            "wrapped_sensitive",
            WRAPPED(resolveColumn(renamed).sources[0] ?? "*")
          );
        }
      }
    }
  }

  for (const select of selects(ast)) {
    for (const item of select.columns as unknown[]) {
      if (!isNode(item)) continue;
      const leak = itemLeak(item);
      if (leak) return refuse("wrapped_sensitive", WRAPPED(leak));
    }
  }

  // Set operations: the result is named after the first branch, so a later
  // branch's sensitive column would show under an unmasked name.
  for (const select of selects(ast)) {
    const parts = branches(select);
    if (parts.length < 2) continue;
    const resolved = parts.map((part) =>
      (part.columns as unknown[]).filter(isNode).map(resolveColumn)
    );
    if (resolved.some((cols) => cols.some((c) => c.star))) {
      return refuse(
        "wrapped_sensitive",
        "UNION, INTERSECT and EXCEPT need explicit column lists (no *), so sensitive columns can be masked."
      );
    }
    const first = resolved[0] as ResolvedColumn[];
    for (const cols of resolved.slice(1)) {
      for (const [i, col] of cols.entries()) {
        if (col.sensitive && !first[i]?.sensitive) {
          return refuse(
            "wrapped_sensitive",
            WRAPPED(col.sources[0] ?? col.name ?? "?")
          );
        }
      }
    }
  }

  if (engine === "mysql") {
    for (const part of branches(ast)) {
      const count = limitCount(part);
      if (count !== null && count > GATE_ROW_LIMIT + 1) {
        return refuse(
          "limit",
          `At most ${GATE_ROW_LIMIT} rows are returned; use LIMIT ${GATE_ROW_LIMIT} or less.`
        );
      }
    }
  }

  const top = branches(ast)[0] as Node;
  return {
    outputColumns: (top.columns as unknown[]).filter(isNode).map(resolveColumn),
  };
}

/**
 * Checks one query for the engine. Accepted: exactly one SELECT (or WITH …
 * SELECT) with no writes, locks, INTO, denied functions or unmasked
 * sensitive values; `normalized` is the text to send (one line, no trailing
 * semicolon) and `outputColumns` the resolved select list of its first (or
 * only) branch. Refused: the reason and a message for the model.
 */
export function checkReadOnlyQuery(
  sql: string,
  engine: GateEngine
): GateResult {
  const lexed = lexicalCheck(sql, engine);
  if ("ok" in lexed) return lexed;
  let parsed: unknown;
  try {
    parsed = parserFor(engine).astify(lexed.text, {
      database: DIALECT[engine],
    });
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error))
      .split("\n")[0]
      ?.slice(0, 300)
      .replace(/\.+$/, "");
    return refuse(
      "parse",
      `The query could not be parsed as one ${engine === "mssql" ? "T-SQL" : engine === "mysql" ? "MySQL" : "PostgreSQL"} SELECT: ${detail}. Use plain SELECT syntax.`
    );
  }
  const statements = (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (s) => s != null
  );
  if (statements.length === 0) {
    return refuse("parse", `The query is empty. ${ONE_SELECT}`);
  }
  if (statements.length > 1) {
    return refuse(
      "multiple",
      `Only one statement can run per call. ${ONE_SELECT}`
    );
  }
  const ast = statements[0];
  if (!isNode(ast) || ast.type !== "select") {
    const type = isNode(ast) && typeof ast.type === "string" ? ast.type : "?";
    return refuse(
      "not_select",
      `${type.toUpperCase()} is not allowed; ${ONE_SELECT}`
    );
  }
  const checked = astCheck(ast, engine);
  if ("ok" in checked) return checked;
  return {
    ok: true,
    normalized: lexed.text,
    outputColumns: checked.outputColumns,
  };
}
