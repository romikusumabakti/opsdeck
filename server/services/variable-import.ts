import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { assertStrongSession, requireProjectPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { variableKindEnum } from "@/lib/db/schema";
import { describeDbError } from "@/lib/secrets-migration";
import { parseDotenv } from "@/lib/variables/dotenv";
import { ESCROWED_MESSAGE } from "@/lib/variables/errors";
import {
  IMPORT_TEXT_MAX_BYTES,
  IMPORT_TEXT_MAX_ENTRIES,
  type ImportExisting,
  type ImportFile,
  type ImportIssue,
  type ImportRow,
  type ImportSkipReason,
  type ImportTemplate,
  type PlannedImportRow,
  planImportRows,
  selectImportWrites,
} from "@/lib/variables/import-rows";
import { decodeVariableValue } from "@/lib/variables/managed-env";
import {
  type EnvironmentContext,
  importVariables,
  listTagVariableNames,
  listTemplates,
  listVariables as listVariableRows,
} from "@/lib/variables/repository";
import {
  readEnvironmentEnvFiles,
  type ServerEnvFile,
  type ServerEnvStatus,
} from "@/lib/variables/server-env";
import { CodedHTTPException } from "@/server/errors";
import { audit, encode, requireEnvironment } from "@/server/services/variables";

/**
 * "Import .env" into an environment's variables, from pasted or uploaded
 * text or from the live `.env` of its deploy dirs. Reading needs what saving
 * needs, `variable:read` + `variable:write`, and the reveal's strong sign-in:
 * reading a server's file is as good as a reveal, and same/conflict on a
 * pasted text would let a weak session test guesses against stored secrets. One parser (lib/variables/dotenv) and one row planner
 * (lib/variables/import-rows) for every source; same/conflict are decided
 * here against the stored values, so no stored secret reaches the browser.
 *
 * No session state: a save re-reads the dirs (409 `envFileChanged` when a
 * fingerprint differs) or re-parses the submitted text, re-validates every
 * row and writes in one transaction. The text and the values never reach an
 * activity row, a log line or an error message; the activity lists names.
 * Opening the review records nothing.
 */

const IMPORT_PERMISSIONS = { variable: ["read", "write"] } as const;

/**
 * The body cap of the routes carrying text: the text (JSON may double it:
 * every newline is escaped) plus room for the rows.
 */
export const IMPORT_BODY_LIMIT = 2 * IMPORT_TEXT_MAX_BYTES + 256 * 1024;

const kindSchema = z.enum(variableKindEnum.enumValues);
// Names are checked in full against the planned rows; these only bound them.
const requestName = z.string().min(1).max(256);

export const importPreviewInputSchema = z
  .object({ source: z.literal("text"), text: z.string() })
  .strict();

export const importSaveInputSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("server"),
      dirs: z
        .array(
          z
            .object({
              deployDir: z.string().min(1).max(4096),
              fingerprint: z.string().min(1).max(128),
            })
            .strict()
        )
        .max(100),
      rows: z
        .array(
          z
            .object({
              name: requestName,
              kind: kindSchema,
              valueId: z.string().min(1).max(256).optional(),
            })
            .strict()
        )
        .min(1)
        .max(IMPORT_TEXT_MAX_ENTRIES),
    })
    .strict(),
  z
    .object({
      source: z.literal("text"),
      text: z.string(),
      rows: z
        .array(z.object({ name: requestName, kind: kindSchema }).strict())
        .min(1)
        .max(IMPORT_TEXT_MAX_ENTRIES),
    })
    .strict(),
]);

export type ImportDir = {
  serverName: string;
  deployDir: string;
  status: ServerEnvStatus;
  line?: number;
  fingerprint?: string;
};

export type ImportReview = {
  rows: ImportRow[];
  skipped: { name: string; reason: ImportSkipReason }[];
};

/** 413 for text over IMPORT_TEXT_MAX_BYTES (also the body cap's refusal). */
export function envTextTooLarge(): CodedHTTPException {
  return new CodedHTTPException(
    413,
    "envTextTooLarge",
    `The .env text must be at most ${IMPORT_TEXT_MAX_BYTES / 1024} KiB`,
    { maxBytes: IMPORT_TEXT_MAX_BYTES }
  );
}

const ISSUE_MESSAGES: Record<ImportIssue["code"], string> = {
  importRowUnknown: "The .env does not define this variable, or it is skipped",
  importRowDuplicate: "Variable is listed twice",
  importRowSame: "The variable already has this value",
  importRowUnimportable: "This variable cannot be imported",
  importSourceRequired: "Choose which deploy dir's value to import",
  importSourceUnknown: "Unknown value choice for this variable",
};

function issueError(issue: ImportIssue): CodedHTTPException {
  const params: Record<string, string> = { name: issue.name };
  if (issue.reason) params.reason = issue.reason;
  return new CodedHTTPException(
    400,
    issue.code,
    ISSUE_MESSAGES[issue.code],
    params
  );
}

async function requireImport(environmentId: string) {
  const { session } = await requireProjectPermission(
    { environmentId },
    IMPORT_PERMISSIONS
  );
  assertStrongSession(session);
  return { session, env: await requireEnvironment(environmentId) };
}

/** What the rows are compared with: stored values (decrypted), templates, tags. */
async function loadComparison(env: EnvironmentContext) {
  const [rows, templates, tagNames] = await Promise.all([
    listVariableRows(env.id),
    env.appId ? listTemplates(env.appId) : Promise.resolve([]),
    listTagVariableNames(env.id),
  ]);
  const existing = new Map<string, ImportExisting>(
    rows.map((row) => [
      row.name,
      { kind: row.kind, value: decodeVariableValue(row), escrow: row.escrow },
    ])
  );
  const templateMap = new Map<string, ImportTemplate>(
    templates.map((t) => [t.name, { kind: t.kind, escrow: t.escrow }])
  );
  return { existing, templates: templateMap, tagNames };
}

function plan(
  files: ImportFile[],
  comparison: Awaited<ReturnType<typeof loadComparison>>
) {
  return planImportRows({ files, ...comparison });
}

function review(planned: ReturnType<typeof plan>): ImportReview {
  return { rows: planned.rows.map((p) => p.row), skipped: planned.skipped };
}

// --- Server source ---

function byDir(a: ServerEnvFile, b: ServerEnvFile): number {
  const left = `${a.serverName}\0${a.deployDir}`;
  const right = `${b.serverName}\0${b.deployDir}`;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The parsed files of the dirs read `ok`. */
function serverFiles(reads: ServerEnvFile[]): ImportFile[] {
  const files: ImportFile[] = [];
  for (const read of reads) {
    if (read.status !== "ok" || read.text === undefined || !read.fingerprint) {
      continue;
    }
    const parsed = parseDotenv(read.text);
    // The reader already parsed it; a file is either ok or parseError.
    if ("error" in parsed) continue;
    files.push({
      dir: {
        serverName: read.serverName,
        deployDir: read.deployDir,
        fingerprint: read.fingerprint,
      },
      entries: parsed.entries,
    });
  }
  return files;
}

async function readDirs(environmentId: string): Promise<ServerEnvFile[]> {
  return (await readEnvironmentEnvFiles(environmentId)).sort(byDir);
}

/**
 * The review of the live `.env` of every deploy dir: each dir's status (no
 * text), the rows and the skipped names.
 */
export async function readServerImport(
  environmentId: string
): Promise<ImportReview & { dirs: ImportDir[] }> {
  const { env } = await requireImport(environmentId);
  const [reads, comparison] = await Promise.all([
    readDirs(env.id),
    loadComparison(env),
  ]);
  return {
    dirs: reads.map((read) => {
      const dir: ImportDir = {
        serverName: read.serverName,
        deployDir: read.deployDir,
        status: read.status,
      };
      if (read.line !== undefined) dir.line = read.line;
      if (read.fingerprint) dir.fingerprint = read.fingerprint;
      return dir;
    }),
    ...review(plan(serverFiles(reads), comparison)),
  };
}

// --- Text source ---

/** The text's entries, or the refusal: too large, unparsable, too many. */
function parseText(text: string): ImportFile {
  if (new TextEncoder().encode(text).length > IMPORT_TEXT_MAX_BYTES) {
    throw envTextTooLarge();
  }
  const parsed = parseDotenv(text);
  if ("error" in parsed) {
    throw new CodedHTTPException(
      400,
      "envParseError",
      `The .env cannot be read at line ${parsed.error.line}`,
      { line: parsed.error.line }
    );
  }
  if (parsed.entries.length > IMPORT_TEXT_MAX_ENTRIES) {
    throw new CodedHTTPException(
      400,
      "envTooManyEntries",
      `The .env may define at most ${IMPORT_TEXT_MAX_ENTRIES} variables`,
      { max: IMPORT_TEXT_MAX_ENTRIES }
    );
  }
  return { entries: parsed.entries };
}

/** The review of pasted or uploaded text. Nothing is stored. */
export async function previewTextImport(
  environmentId: string,
  text: string
): Promise<ImportReview> {
  const { env } = await requireImport(environmentId);
  const file = parseText(text);
  return review(plan([file], await loadComparison(env)));
}

// --- Save ---

/**
 * Runs the save's transaction. A refusal (HTTPException) passes through; any
 * other failure is logged by its SQLSTATE only and answered with a coded 500:
 * drizzle's error message carries the query parameters, the values written.
 */
async function inImportTransaction<T>(
  fn: Parameters<typeof db.transaction<T>>[0]
): Promise<T> {
  try {
    return await db.transaction(fn);
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    console.error(`Variable import failed: ${describeDbError(error)}`);
    throw new CodedHTTPException(
      500,
      "variableImportFailed",
      "The variables could not be imported"
    );
  }
}

function dirKey(deployDir: string, fingerprint: string): string {
  return JSON.stringify([deployDir, fingerprint]);
}

/**
 * Imports the chosen rows: the dirs are re-read (or the text re-parsed) and
 * every row re-validated, then all are written in one transaction or none.
 */
export async function saveImport(
  environmentId: string,
  input: z.infer<typeof importSaveInputSchema>
): Promise<{ imported: number; overwritten: number }> {
  const { session, env } = await requireImport(environmentId);

  let files: ImportFile[];
  let dirs: string | undefined;
  if (input.source === "server") {
    const reads = await readDirs(env.id);
    const okReads = reads.filter((r) => r.status === "ok" && r.fingerprint);
    const now = okReads
      .map((r) => dirKey(r.deployDir, r.fingerprint as string))
      .sort();
    const reviewed = input.dirs
      .map((d) => dirKey(d.deployDir, d.fingerprint))
      .sort();
    if (JSON.stringify(now) !== JSON.stringify(reviewed)) {
      throw new CodedHTTPException(
        409,
        "envFileChanged",
        "A .env file changed since the review: reload it"
      );
    }
    files = serverFiles(okReads);
    dirs = okReads.map((r) => `${r.serverName}:${r.deployDir}`).join(", ");
  } else {
    files = [parseText(input.text)];
  }

  const planned: PlannedImportRow[] = plan(
    files,
    await loadComparison(env)
  ).rows;
  const selected = selectImportWrites(planned, input.rows);
  if ("issue" in selected) throw issueError(selected.issue);

  const written = await inImportTransaction(async (tx) => {
    const result = await importVariables(
      tx,
      selected.writes.map((w) => ({
        environmentId: env.id,
        name: w.name,
        kind: w.kind,
        value: encode(w.kind, w.value),
        escrow: w.escrow,
        updatedBy: session.user.id,
      }))
    );
    // An escrow set since the read: write nothing.
    if (result.length !== selected.writes.length) {
      throw new CodedHTTPException(409, "variableEscrowed", ESCROWED_MESSAGE);
    }
    return result;
  });

  const names = written.map((w) => w.name).sort();
  const overwritten = written
    .filter((w) => w.overwritten)
    .map((w) => w.name)
    .sort();
  await audit(session.user.id, env, "variables.imported", {
    source: input.source,
    names: names.join(", "),
    overwritten: overwritten.join(", "),
    ...(dirs === undefined ? {} : { dirs }),
  });
  return { imported: names.length, overwritten: overwritten.length };
}
