import { z } from "zod";
import { roleOn } from "@/lib/access-scope";
import { recordActivity } from "@/lib/activity";
import { checkReadOnlyQuery, type GateRefusal } from "@/lib/assistant-db/gate";
import {
  type AssistantDbLogin,
  getAssistantDbLogin,
} from "@/lib/assistant-db/login";
import { type Cell, isSensitiveName, maskRows } from "@/lib/assistant-db/mask";
import {
  AssistantDbQueryError,
  type QueryResult,
  runAssistantDbQuery,
} from "@/lib/assistant-db/query";
import { redactEngineError, redactLiterals } from "@/lib/assistant-db/redact";
import type { EnvironmentListItem } from "@/lib/db/schema";
import { environmentName } from "@/lib/environments";
import { holdsEngineerAnywhere } from "@/lib/permissions";
import { redactSecretLines } from "../secret-filter";
import type { AssistantViewer } from "../viewer";
import type { ToolMeta, ToolResult } from "./code";
import {
  environmentByRef,
  envRef,
  type PanelContext,
  unknownEnvironment,
} from "./panel";

// The Assistant's read-only database tools (Stage 9 spec F.3): list_tables
// and query_database on an environment an admin/infra enabled
// (lib/assistant-db/login), for engineer, infra and admin users who can see
// that environment. Every query passes the gate (lib/assistant-db/gate)
// before anything is sent, runs as the environment's dedicated read-only
// login (lib/assistant-db/query), comes back capped and masked, and is
// written to the activity log with its literals replaced by `?`.

/** Rows query_database returns (one more is fetched to tell it was capped). */
export const MAX_QUERY_ROWS = 100;
/** A cell longer than this is cut. */
export const MAX_CELL_CHARS = 500;
/** The rows' JSON, at most. */
export const MAX_QUERY_BYTES = 32 * 1024;
/** Columns list_tables reads (all tables together). */
export const MAX_SCHEMA_COLUMNS = 3000;
/** list_tables' JSON, at most. */
export const MAX_SCHEMA_BYTES = 48 * 1024;

export const DATABASE_ACTIVITY = "assistant.databaseQuery";

const environmentArg = z
  .string()
  .describe(
    'Environment as "PROJECTKEY/slug" (from list_environments, e.g. "ACME/uat") or its id.'
  );

const DEFINITIONS = {
  list_tables: {
    description: `List the tables and views of one environment's database with their columns and types (at most ${MAX_SCHEMA_COLUMNS} columns in all). Only for environments whose database an admin or infra user opened to the Assistant (read-only); otherwise it says so. Columns marked "masked" hold personal data or credentials and come back as •••.`,
    inputSchema: z.strictObject({ environment: environmentArg }),
  },
  query_database: {
    description: `Run one read-only SELECT (or WITH … SELECT) on one environment's database, as a login that can only read that database. Only for environments whose database an admin or infra user opened to the Assistant. At most ${MAX_QUERY_ROWS} rows (cells cut at ${MAX_CELL_CHARS} characters, ${MAX_QUERY_BYTES / 1024} KiB in all), 10 s per query. Columns holding personal data or credentials (password, token, NIK, NPWP, email, phone, address, birth date, account or card number…) come back as •••; select such a column plainly, never renamed or inside an expression (that is refused). No comments, no backslashes, no ";" inside the query. Use the engine's own dialect (list_tables names it).`,
    inputSchema: z.strictObject({
      environment: environmentArg,
      sql: z
        .string()
        .describe(
          "One SELECT statement in the database's dialect (PostgreSQL, T-SQL or MySQL), using names from list_tables."
        ),
    }),
  },
} as const;

export type DatabaseToolName = keyof typeof DEFINITIONS;

export const DATABASE_TOOL_NAMES = Object.keys(
  DEFINITIONS
) as DatabaseToolName[];

export function isDatabaseTool(name: string): name is DatabaseToolName {
  return Object.hasOwn(DEFINITIONS, name);
}

/** Engineer, infra and admin only; never QA, BA, PM, staff or observer. */
export function databaseToolsOffered(viewer: AssistantViewer): boolean {
  return holdsEngineerAnywhere(viewer.orgRole);
}

/** The database tools offered to this viewer, with what the model sees. */
export function databaseDefinitions(
  viewer: AssistantViewer
): Array<[DatabaseToolName, (typeof DEFINITIONS)[DatabaseToolName]]> {
  return databaseToolsOffered(viewer)
    ? (Object.entries(DEFINITIONS) as Array<
        [DatabaseToolName, (typeof DEFINITIONS)[DatabaseToolName]]
      >)
    : [];
}

/** Validation, independent of the schemas the model sees. */
export const DATABASE_INPUTS = {
  list_tables: z.strictObject({ environment: z.string() }),
  query_database: z.strictObject({ environment: z.string(), sql: z.string() }),
} as const satisfies Record<DatabaseToolName, z.ZodType>;

export type DatabaseActivity = {
  actorId: string;
  environmentId: string;
  sql: string;
  engine: AssistantDbLogin["engine"] | null;
  rows: number;
  durationMs: number;
  outcome: "ok" | "refused" | "failed";
  reason: GateRefusal | "notEnabled" | "forbidden" | "";
};

/** What the tools read and write through (tests replace them). */
export type DatabaseDeps = {
  getLogin: typeof getAssistantDbLogin;
  run: (
    environmentId: string,
    login: AssistantDbLogin,
    sql: string,
    rowLimit: number
  ) => Promise<QueryResult>;
  record: (activity: DatabaseActivity) => Promise<void>;
  now: () => number;
};

async function recordQuery(activity: DatabaseActivity): Promise<void> {
  await recordActivity({
    actorId: activity.actorId,
    action: DATABASE_ACTIVITY,
    entityType: "environment",
    entityId: activity.environmentId,
    data: {
      environment:
        (await environmentName(activity.environmentId)) ??
        activity.environmentId,
      sql: redactLiterals(activity.sql, activity.engine ?? "postgres"),
      rows: activity.rows,
      durationMs: activity.durationMs,
      outcome: activity.outcome,
      reason: activity.reason,
    },
  });
}

export const DATABASE_DEPS: DatabaseDeps = {
  getLogin: getAssistantDbLogin,
  run: runAssistantDbQuery,
  record: recordQuery,
  now: Date.now,
};

const fail = (error: string, meta: ToolMeta = {}): ToolResult<never> => ({
  ok: false,
  error,
  meta,
});

export const notEnabledError = (ref: string) =>
  `Database queries are not enabled for ${ref}. Say so, and that an admin or infra user can turn on "Let the Assistant query this database (read-only)" in that environment's Settings › Database (only for environments without real participant data). Never guess the data.`;

const FORBIDDEN =
  "Database queries are only available to engineers, infra and admins.";

const ENGINE_NAME: Record<AssistantDbLogin["engine"], string> = {
  postgres: "PostgreSQL",
  mssql: "SQL Server (T-SQL)",
  mysql: "MySQL/MariaDB",
};

type Resolved =
  | { ok: true; env: EnvironmentListItem; login: AssistantDbLogin }
  | { ok: false; result: ToolResult<never>; env?: EnvironmentListItem };

/**
 * The environment and its login, after the access checks: engineer/infra/
 * admin, an environment the viewer sees (list_environments' own list) with
 * the engineer role on its project, and access enabled.
 */
async function resolve(
  ctx: PanelContext,
  given: string,
  deps: DatabaseDeps
): Promise<Resolved> {
  if (!databaseToolsOffered(ctx.viewer)) {
    return { ok: false, result: fail(FORBIDDEN) };
  }
  const env = await environmentByRef(ctx, given);
  if (!env) {
    return { ok: false, result: fail(unknownEnvironment(given.trim())) };
  }
  const meta = { project: env.key, environment: envRef(env) };
  if (roleOn(ctx.viewer.scope, env.projectId) !== "engineer") {
    return { ok: false, env, result: fail(FORBIDDEN, meta) };
  }
  const login = await deps.getLogin(env.id);
  if (!login) {
    return {
      ok: false,
      env,
      result: fail(notEnabledError(envRef(env)), {
        ...meta,
        reason: "notEnabled",
      }),
    };
  }
  return { ok: true, env, login };
}

const failedMessage = (error: unknown) =>
  error instanceof AssistantDbQueryError
    ? `The database returned an error (values and quoted names shown as ?): ${redactEngineError(redactSecretLines(error.message).text)}`
    : "The query could not be run on the database server.";

// --- list_tables ---------------------------------------------------------------------

const SCHEMA_SQL: Record<AssistantDbLogin["engine"], string> = {
  // Only what the login can read: information_schema hides the rest.
  postgres:
    "SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND left(table_schema, 3) <> 'pg_' ORDER BY table_schema, table_name, ordinal_position",
  mssql:
    "SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION",
  mysql:
    "SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = DATABASE() ORDER BY table_name, ordinal_position",
};

type ListedTable = { name: string; columns: string[] };

async function listTablesTool(
  ctx: PanelContext,
  given: string,
  deps: DatabaseDeps
): Promise<ToolResult<unknown>> {
  const resolved = await resolve(ctx, given, deps);
  if (!resolved.ok) return resolved.result;
  const { env, login } = resolved;
  const meta: ToolMeta = { project: env.key, environment: envRef(env) };
  let result: QueryResult;
  try {
    result = await deps.run(
      env.id,
      login,
      SCHEMA_SQL[login.engine],
      MAX_SCHEMA_COLUMNS + 1
    );
  } catch (error) {
    return fail(failedMessage(error), meta);
  }
  const capped = result.rows.length > MAX_SCHEMA_COLUMNS;
  const tables: ListedTable[] = [];
  for (const [schema, table, column, type] of result.rows.slice(
    0,
    MAX_SCHEMA_COLUMNS
  )) {
    const name =
      login.engine === "mysql" || !schema
        ? String(table)
        : `${schema}.${table}`;
    let entry = tables[tables.length - 1];
    if (entry?.name !== name) {
      entry = { name, columns: [] };
      tables.push(entry);
    }
    const masked = column && isSensitiveName(column) ? " (masked)" : "";
    entry.columns.push(`${column} ${type ?? ""}`.trim() + masked);
  }
  // Whole tables only, within the byte cap.
  const shown: ListedTable[] = [];
  let bytes = 0;
  for (const table of tables) {
    const size = Buffer.byteLength(JSON.stringify(table)) + 1;
    if (bytes + size > MAX_SCHEMA_BYTES) break;
    shown.push(table);
    bytes += size;
  }
  const more = tables.length - shown.length;
  return {
    ok: true,
    data: {
      environment: envRef(env),
      engine: ENGINE_NAME[login.engine],
      database: login.database,
      tables: shown,
      ...(more > 0 ? { moreTables: more } : {}),
      ...(capped
        ? {
            truncated: `only the first ${MAX_SCHEMA_COLUMNS} columns were read`,
          }
        : {}),
    },
    meta: {
      ...meta,
      tables: shown.length,
      ...(capped || more > 0 ? { capped: true } : {}),
    },
  };
}

// --- query_database -------------------------------------------------------------------

function cutCell(cell: Cell): { cell: Cell; cut: boolean; redacted: boolean } {
  if (cell === null) return { cell, cut: false, redacted: false };
  const filtered = redactSecretLines(cell);
  const text = filtered.text;
  const cut = text.length > MAX_CELL_CHARS;
  return {
    cell: cut ? `${text.slice(0, MAX_CELL_CHARS)}…` : text,
    cut,
    redacted: filtered.redacted > 0,
  };
}

async function queryDatabaseTool(
  ctx: PanelContext,
  input: { environment: string; sql: string },
  deps: DatabaseDeps
): Promise<ToolResult<unknown>> {
  const started = deps.now();
  const resolved = await resolve(ctx, input.environment, deps);
  const activity = (
    env: EnvironmentListItem,
    engine: AssistantDbLogin["engine"] | null,
    outcome: DatabaseActivity["outcome"],
    reason: DatabaseActivity["reason"],
    rows = 0
  ) =>
    deps.record({
      actorId: ctx.viewer.userId,
      environmentId: env.id,
      sql: input.sql,
      engine,
      rows,
      durationMs: Math.max(0, Math.round(deps.now() - started)),
      outcome,
      reason,
    });
  if (!resolved.ok) {
    // A query on an environment the user sees but that isn't enabled is
    // still logged; an unknown or forbidden one names no environment.
    if (resolved.env && resolved.result.meta.reason === "notEnabled") {
      await activity(resolved.env, null, "refused", "notEnabled");
    }
    return resolved.result;
  }
  const { env, login } = resolved;
  const meta: ToolMeta = { project: env.key, environment: envRef(env) };

  const gate = checkReadOnlyQuery(input.sql, login.engine);
  if (!gate.ok) {
    await activity(env, login.engine, "refused", gate.reason);
    return fail(`Query refused: ${gate.message}`, {
      ...meta,
      reason: gate.reason,
    });
  }

  let result: QueryResult;
  try {
    result = await deps.run(env.id, login, gate.normalized, MAX_QUERY_ROWS + 1);
  } catch (error) {
    await activity(env, login.engine, "failed", "");
    return fail(failedMessage(error), meta);
  }

  const capped = result.rows.length > MAX_QUERY_ROWS;
  // The gate's resolution lines up with the result only without a star.
  const aligned = gate.outputColumns.some((c) => c.star)
    ? []
    : gate.outputColumns.map((c) => c.sensitive);
  const masked = maskRows(
    result.columns,
    result.rows.slice(0, MAX_QUERY_ROWS),
    aligned
  );
  let cutCells = 0;
  let redactedCells = 0;
  const rows = masked.rows.map((row) =>
    row.map((cell) => {
      const out = cutCell(cell);
      if (out.cut) cutCells++;
      if (out.redacted) redactedCells++;
      return out.cell;
    })
  );
  // Whole rows only, within the byte cap.
  const shown: Cell[][] = [];
  // The columns, the brackets, and a comma per row.
  let bytes = Buffer.byteLength(JSON.stringify(result.columns)) + 2;
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (bytes + size > MAX_QUERY_BYTES) break;
    shown.push(row);
    bytes += size;
  }
  const notes: string[] = [];
  if (capped) {
    notes.push(
      `More rows exist: only the first ${MAX_QUERY_ROWS} were read; narrow the query or aggregate.`
    );
  }
  if (shown.length < rows.length) {
    notes.push(
      `Only ${shown.length} of ${rows.length} rows fit in ${MAX_QUERY_BYTES / 1024} KiB; select fewer or shorter columns.`
    );
  }
  if (cutCells > 0) {
    notes.push(`${cutCells} cells were cut at ${MAX_CELL_CHARS} characters.`);
  }
  if (masked.masked.length > 0) {
    notes.push(
      `Masked as •••: ${[...new Set(masked.masked)].join(", ")} (personal data or credentials; never guess their values).`
    );
  }
  if (redactedCells > 0) {
    notes.push(`${redactedCells} cells held credentials and were redacted.`);
  }
  await activity(env, login.engine, "ok", "", shown.length);
  return {
    ok: true,
    data: {
      environment: envRef(env),
      columns: result.columns,
      rows: shown,
      rowCount: shown.length,
      ...(capped || shown.length < rows.length ? { capped: true } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    },
    meta: {
      ...meta,
      rows: shown.length,
      ...(capped ? { capped: true } : {}),
      ...(masked.masked.length > 0 ? { masked: masked.masked.length } : {}),
    },
  };
}

export async function runDatabaseTool(
  name: DatabaseToolName,
  input: unknown,
  ctx: PanelContext,
  deps: DatabaseDeps = DATABASE_DEPS
): Promise<ToolResult<unknown>> {
  switch (name) {
    case "list_tables": {
      const i = input as z.infer<typeof DATABASE_INPUTS.list_tables>;
      return listTablesTool(ctx, i.environment, deps);
    }
    case "query_database": {
      const i = input as z.infer<typeof DATABASE_INPUTS.query_database>;
      return queryDatabaseTool(ctx, i, deps);
    }
  }
}
