import type { DatabaseType } from "@/lib/services";

// A small SQL lexer, enough to tell string literals, quoted identifiers and
// comments from the rest. The gate uses it to check what a query's literals
// hold; the activity log gets the SQL with every literal replaced by `?`
// (Stage 9 spec F.3: literals in a WHERE may hold identifiers such as a NIK,
// and observers read the activity log). Pure.

export type SqlSegment = {
  kind: "code" | "string" | "identifier" | "comment";
  text: string;
};

/** A literal's one-letter prefix: N'…', E'…', B'…', X'…' (and U&'…'). */
const PREFIX = /(?:^|[^\w$])((?:[NnEeBbXx])|(?:[Uu]&))$/;

/**
 * Splits SQL into segments. Postgres and SQL Server quote identifiers in
 * double quotes, MySQL quotes strings in them (and identifiers in
 * backticks); SQL Server also brackets identifiers. Comments are `--`, `/* … *\/`
 * and, on MySQL, `#`. Postgres dollar-quoted strings are strings. Doubled
 * quotes escape a quote; an unterminated segment runs to the end.
 */
export function sqlSegments(
  sql: string,
  engine: DatabaseType = "postgres"
): SqlSegment[] {
  const out: SqlSegment[] = [];
  let code = "";
  const flush = () => {
    if (code) out.push({ kind: "code", text: code });
    code = "";
  };
  const quoted = (start: number, close: string): number => {
    let i = start + 1;
    while (i < sql.length) {
      if (sql[i] === close) {
        if (sql[i + 1] === close) {
          i += 2;
          continue;
        }
        return i + 1;
      }
      i++;
    }
    return sql.length;
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i] as string;
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      flush();
      const stop = end < 0 ? sql.length : end;
      out.push({ kind: "comment", text: sql.slice(i, stop) });
      i = stop;
      continue;
    }
    if (c === "#" && engine === "mysql") {
      const end = sql.indexOf("\n", i);
      flush();
      const stop = end < 0 ? sql.length : end;
      out.push({ kind: "comment", text: sql.slice(i, stop) });
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      flush();
      const stop = end < 0 ? sql.length : end + 2;
      out.push({ kind: "comment", text: sql.slice(i, stop) });
      i = stop;
      continue;
    }
    if (c === "'") {
      // A one-letter prefix belongs to the literal.
      const prefix = PREFIX.exec(code)?.[1] ?? "";
      code = code.slice(0, code.length - prefix.length);
      flush();
      const stop = quoted(i, "'");
      out.push({ kind: "string", text: prefix + sql.slice(i, stop) });
      i = stop;
      continue;
    }
    if (c === '"') {
      flush();
      const stop = quoted(i, '"');
      out.push({
        kind: engine === "mysql" ? "string" : "identifier",
        text: sql.slice(i, stop),
      });
      i = stop;
      continue;
    }
    if (c === "`" && engine === "mysql") {
      flush();
      const stop = quoted(i, "`");
      out.push({ kind: "identifier", text: sql.slice(i, stop) });
      i = stop;
      continue;
    }
    if (c === "[" && engine === "mssql") {
      flush();
      const stop = quoted(i, "]");
      out.push({ kind: "identifier", text: sql.slice(i, stop) });
      i = stop;
      continue;
    }
    if (c === "$" && engine === "postgres") {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      // `$1` (a parameter) or `x$y` (an identifier) is code.
      if (tag && !/[\w$]$/.test(code)) {
        const end = sql.indexOf(tag, i + tag.length);
        flush();
        const stop = end < 0 ? sql.length : end + tag.length;
        out.push({ kind: "string", text: sql.slice(i, stop) });
        i = stop;
        continue;
      }
    }
    code += c;
    i++;
  }
  flush();
  return out;
}

/** Numbers that stand alone: not part of an identifier like `t1` or `$1`. */
const NUMBER =
  /(?<![\w$.])(?:0x[0-9a-f]+|\d+(?:\.\d*)?(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)(?![\w.])/gi;

/** Longest SQL an activity entry keeps. */
export const MAX_REDACTED_SQL = 2000;

/**
 * The SQL with every string and numeric literal replaced by `?` and its
 * comments removed, on one line, at most MAX_REDACTED_SQL characters.
 * Identifiers stay. With a backslash anywhere, quoting is ambiguous (MySQL
 * escapes with it, standard SQL does not), so everything from the first
 * quote on is one literal.
 */
export function redactLiterals(
  sql: string,
  engine: DatabaseType = "postgres"
): string {
  let text = sql;
  let tail = "";
  if (text.includes("\\")) {
    const quote = text.search(/['"`$[]/);
    if (quote >= 0) {
      text = text.slice(0, quote);
      tail = " ?";
    }
  }
  const redacted =
    sqlSegments(text, engine)
      .map((segment) => {
        switch (segment.kind) {
          case "string":
            return "?";
          case "comment":
            return " ";
          case "identifier":
            return segment.text;
          default:
            return segment.text.replace(NUMBER, "?");
        }
      })
      .join("") + tail;
  const line = redacted.replace(/\s+/g, " ").trim();
  return line.length > MAX_REDACTED_SQL
    ? `${line.slice(0, MAX_REDACTED_SQL)}…`
    : line;
}

/**
 * Engine error text with every value it could echo taken out, for the
 * model, logs and anything else outside the server (Stage 9: a masked value
 * must not come back through an error such as SQL Server's Msg 245
 * "Conversion failed when converting the varchar value '<value>' …" or
 * Postgres' `invalid input syntax for type integer: "<value>"`). Quoted
 * substrings ('…', "…", `…`) become `?`, Postgres `Key (…)=(…)` values
 * become `(?)`, and DETAIL / CONTEXT / WHERE lines, which echo row values,
 * are dropped. Names in quotes go too; the error class and position stay.
 */
export function redactEngineError(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:DETAIL|CONTEXT|WHERE):/i.test(line))
    .map((line) =>
      line
        .replace(/\)=\((?:[^()]|\([^()]*\))*\)/g, ")=(?)")
        .replace(/'(?:[^']|'')*'?/g, "?")
        .replace(/"(?:[^"]|"")*"?/g, "?")
        .replace(/`(?:[^`]|``)*`?/g, "?")
    )
    .join("\n")
    .trim();
}
