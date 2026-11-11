// Restoring an instance backup (`opsdeck restore <objectKey>`, run by the host
// updater with the app and terminal stopped, under the backup's version).
//
// The exit-code contract with update.sh is in lib/updates/request.ts: every
// check runs before anything live is written, and a refusal leaves the
// database and Garage untouched.
//
//  1. Read the manifest (`restoreNotFound`), check its version against the
//     running one (`restoreVersionMismatch`) and the SECRETS_KEY fingerprint
//     (`restoreKeyMismatch`).
//  2. Stage the backup (an S3 backup is downloaded; a local one is read in
//     place) and check the dump's sha256 and the stored files' totals
//     (`restoreChecksumMismatch`).
//  3. Build the database in a scratch database (`<db>_restore`) with
//     pg_restore. pg_restore --clean only drops what the dump knows, so
//     restoring over the live database would keep tables and columns that
//     exist only in a newer schema; a fresh database holds exactly the dump,
//     drizzle.__drizzle_migrations included (so a later migrate runs only
//     the newer migrations).
//  4. Swap it in: both renames in one transaction, so the live database is
//     either the old one or the restored one. The old one is then dropped
//     (the pre-restore safety backup is the way back).
//  5. Mirror the stored files into Garage: upload every backed-up object,
//     then delete the ones the backup does not have. Release files are not in
//     backups (archive.ts RELEASES_PREFIX), so they are left as they are.
// A failure up to and including 4 is a refusal (nothing live changed); a
// failure in 5 is `failed`.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import postgres from "postgres";
import { BACKUP_OBJECT_KEY_RE } from "@/lib/updates/request";
import {
  filesUnder,
  LOCAL_BACKUP_ROOT,
  pgEnv,
  RELEASES_PREFIX,
} from "./archive";
import {
  type BackupDestination,
  loadBackupDestination,
  type ObjectStore,
  restoreS3Source,
} from "./destination";
import {
  type BackupManifest,
  DATABASE_FILE,
  GARAGE_DIR,
  MANIFEST_FILE,
  parseManifest,
  secretsKeyFingerprint,
} from "./manifest";

export type RestoreErrorCode =
  // refused: nothing live was changed
  | "restoreNotFound"
  | "restoreChecksumMismatch"
  | "restoreKeyMismatch"
  | "restoreVersionMismatch"
  | "restoreGarageUnavailable"
  | "restoreStagingFailed"
  | "restoreDatabaseFailed"
  // failed: the database was replaced
  | "restoreGarageFailed"
  | "restoreFailed";

export class RestoreError extends Error {
  constructor(
    readonly code: RestoreErrorCode,
    detail?: string
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "RestoreError";
  }
}

/**
 * The swap's COMMIT was sent but its outcome could not be read back: the
 * live database may already be the restored one, so the run is `failed`.
 */
export class SwapOutcomeUnknownError extends Error {
  constructor(detail: string) {
    super(`swap outcome unknown: ${detail}`);
    this.name = "SwapOutcomeUnknownError";
  }
}

/** Errors of the local disk (staging), as opposed to reading the source. */
const DISK_ERRORS = new Set([
  "ENOSPC",
  "EDQUOT",
  "EROFS",
  "EACCES",
  "EPERM",
  "EIO",
  "EMFILE",
]);

/** A failure reading the backup: the disk's own (restoreStagingFailed) or the source's. */
function sourceError(error: unknown): RestoreError {
  if (error instanceof RestoreError) return error;
  const code = (error as { code?: string })?.code;
  return new RestoreError(
    code && DISK_ERRORS.has(code) ? "restoreStagingFailed" : "restoreNotFound",
    describe(error)
  );
}

/** Runs `fn`, classifying its failure with sourceError. */
async function reading<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw sourceError(error);
  }
}

export type RestoreResult = {
  status: "restored" | "refused" | "failed";
  errorCode: RestoreErrorCode | null;
  /** The manifest's version, once it was read. */
  version: string | null;
};

/** Where a backup is read from. */
export interface BackupSource {
  /** The manifest text; `stagingDir` is scratch space it may use. */
  readManifest(stagingDir: string): Promise<string>;
  /** A dir holding database.dump and garage/ (staged there, or in place). */
  stage(stagingDir: string): Promise<string>;
}

/** The database side, so the flow can be tested without Postgres. */
export interface RestoreDatabase {
  /** Builds the scratch database from the dump. Never touches the live one. */
  prepare(dumpPath: string): Promise<void>;
  /** Atomically puts the scratch database in place of the live one. */
  swap(): Promise<void>;
  /** Drops the database the swap replaced. */
  dropPrevious(): Promise<void>;
  close(): Promise<void>;
}

export interface RestoreDeps {
  /** OPSDECK_VERSION of this process; the manifest must match it. */
  version: string;
  secretsKey: string | undefined;
  openSource(objectKey: string): Promise<BackupSource>;
  /** The app's Garage bucket; null when Garage is not provisioned. */
  garage: ObjectStore | null;
  database: RestoreDatabase;
  /** Where an S3 backup is downloaded to (a fresh dir per run inside it). */
  stagingRoot: string;
  /** Diagnostics (stderr in the CLI). Never given a secret. */
  log(line: string): void;
}

/** A backup in the local backups dir; `path` is `<instance>/<name>/`. */
export function localBackupSource(root: string, path: string): BackupSource {
  const base = resolve(root);
  const dir = resolve(base, path);
  if (!dir.startsWith(base + sep)) {
    throw new RestoreError("restoreNotFound", "path outside the backups dir");
  }
  return {
    readManifest: () => readFile(join(dir, MANIFEST_FILE), "utf8"),
    stage: async () => dir,
  };
}

/** A backup on the S3 destination under `prefix` (ends with `/`). */
export function s3BackupSource(store: ObjectStore, key: string): BackupSource {
  const prefix = key.endsWith("/") ? key : `${key}/`;
  return {
    async readManifest(stagingDir) {
      const file = join(stagingDir, MANIFEST_FILE);
      await mkdir(stagingDir, { recursive: true });
      await store.download(`${prefix}${MANIFEST_FILE}`, file);
      return readFile(file, "utf8");
    },
    async stage(stagingDir) {
      for (const { key: objectKey, size } of await store.list(prefix)) {
        const rel = objectKey.slice(prefix.length);
        if (rel === MANIFEST_FILE || (rel.endsWith("/") && size === 0)) {
          continue;
        }
        const target = resolve(stagingDir, rel);
        if (!target.startsWith(resolve(stagingDir) + sep)) {
          throw new RestoreError("restoreNotFound", "unsafe object key");
        }
        await mkdir(dirname(target), { recursive: true });
        await store.download(objectKey, target);
      }
      return stagingDir;
    },
  };
}

/**
 * The source of a restore key: `local:<instance>/<name>/` in the local
 * backups dir; anything else on the S3 store from OPSDECK_RESTORE_S3_* when
 * set (a fresh install, whose database has no destination yet), else on the
 * configured S3 destination.
 */
export async function openBackupSource(
  objectKey: string,
  loadDestination: () => Promise<BackupDestination | null> = loadBackupDestination,
  localRoot: string = LOCAL_BACKUP_ROOT,
  envSource: () => ObjectStore | null = () => restoreS3Source()
): Promise<BackupSource> {
  if (objectKey.startsWith("local:")) {
    return localBackupSource(localRoot, objectKey.slice("local:".length));
  }
  let fromEnv: ObjectStore | null;
  try {
    fromEnv = envSource();
  } catch (error) {
    throw new RestoreError(
      "restoreNotFound",
      error instanceof Error ? error.message : "invalid OPSDECK_RESTORE_S3_*"
    );
  }
  if (fromEnv) return s3BackupSource(fromEnv, objectKey);
  const destination = await loadDestination();
  if (!destination) {
    throw new RestoreError("restoreNotFound", "no backup destination is set");
  }
  return s3BackupSource(destination.store, objectKey);
}

async function sha256File(
  path: string
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

/** The dump's hash and the stored files' totals equal the manifest's. */
async function verifyStaged(
  dir: string,
  manifest: BackupManifest
): Promise<void> {
  const dump = await sha256File(join(dir, DATABASE_FILE)).catch(() => null);
  if (
    !dump ||
    dump.sha256 !== manifest.database.sha256 ||
    dump.bytes !== manifest.database.bytes
  ) {
    throw new RestoreError("restoreChecksumMismatch", "database dump");
  }
  const garageDir = join(dir, GARAGE_DIR);
  const files = await filesUnder(garageDir).catch(() => [] as string[]);
  let bytes = 0;
  for (const f of files) bytes += (await stat(join(garageDir, f))).size;
  if (
    files.length !== manifest.garage.objects ||
    bytes !== manifest.garage.bytes
  ) {
    throw new RestoreError("restoreChecksumMismatch", "stored files");
  }
}

/**
 * Makes the bucket hold exactly the files under `garageDir`, apart from
 * release files: backups skip them, so the bucket's own copies are kept.
 */
async function mirrorIntoGarage(
  garage: ObjectStore,
  garageDir: string
): Promise<void> {
  const files = await filesUnder(garageDir).catch(() => [] as string[]);
  for (const key of files) await garage.upload(key, join(garageDir, key));
  const keep = new Set(files);
  const extra = (await garage.list(""))
    .map((o) => o.key)
    .filter((key) => !keep.has(key) && !key.startsWith(RELEASES_PREFIX));
  if (extra.length > 0) await garage.delete(extra);
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error).slice(0, 200);
  return `${error.name} ${error.message.split("\n")[0]?.slice(0, 200) ?? ""}`.trim();
}

/** Runs `fn`, turning an error that is not a RestoreError into `code`. */
async function step<T>(
  code: RestoreErrorCode,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof RestoreError) throw error;
    throw new RestoreError(code, describe(error));
  }
}

export async function runRestore(
  objectKey: string,
  deps: RestoreDeps
): Promise<RestoreResult> {
  const { log } = deps;
  const staging = join(
    deps.stagingRoot,
    `.restore-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  );
  let version: string | null = null;
  // Set once the live database was replaced: from then on it is `failed`.
  let swapped = false;
  try {
    if (!BACKUP_OBJECT_KEY_RE.test(objectKey)) {
      throw new RestoreError("restoreNotFound", "invalid object key");
    }
    const source = await step("restoreNotFound", () =>
      deps.openSource(objectKey)
    );
    const text = await reading(() => source.readManifest(staging));
    let manifest: BackupManifest;
    try {
      manifest = parseManifest(text);
    } catch (error) {
      throw new RestoreError("restoreChecksumMismatch", describe(error));
    }
    version = manifest.version;
    if (manifest.version !== deps.version) {
      throw new RestoreError(
        "restoreVersionMismatch",
        `backup ${manifest.version}, running ${deps.version}`
      );
    }
    if (
      !deps.secretsKey ||
      secretsKeyFingerprint(deps.secretsKey) !== manifest.secretsKeyFingerprint
    ) {
      throw new RestoreError("restoreKeyMismatch");
    }
    if (manifest.garage.objects > 0 && !deps.garage) {
      throw new RestoreError("restoreGarageUnavailable");
    }
    const dir = await reading(() => source.stage(staging));
    await verifyStaged(dir, manifest);

    // Nothing live has changed up to here.
    await step("restoreDatabaseFailed", () =>
      deps.database.prepare(join(dir, DATABASE_FILE))
    );
    try {
      await deps.database.swap();
    } catch (error) {
      if (error instanceof SwapOutcomeUnknownError) {
        swapped = true;
        throw new RestoreError("restoreFailed", error.message);
      }
      throw new RestoreError("restoreDatabaseFailed", describe(error));
    }
    swapped = true;
    log("restore: database replaced");
    await deps.database
      .dropPrevious()
      .catch((e) => log(`restoreDropPreviousFailed: ${describe(e)}`));

    if (deps.garage) {
      const garage = deps.garage;
      await step("restoreGarageFailed", () =>
        mirrorIntoGarage(garage, join(dir, GARAGE_DIR))
      );
      log("restore: stored files replaced");
    }
    return { status: "restored", errorCode: null, version };
  } catch (error) {
    const restoreError =
      error instanceof RestoreError
        ? error
        : new RestoreError("restoreFailed", describe(error));
    log(restoreError.message);
    return {
      status: swapped ? "failed" : "refused",
      errorCode: restoreError.code,
      version,
    };
  } finally {
    await deps.database
      .close()
      .catch((e) => log(`restoreCloseFailed: ${describe(e)}`));
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

// --- Postgres --------------------------------------------------------------

/** The flags the dump is restored with; --exit-on-error is added so no error is ignored. */
export const PG_RESTORE_FLAGS = [
  "--clean",
  "--if-exists",
  "--no-owner",
] as const;

type Sql = ReturnType<typeof postgres>;

export type Spawner = (
  cmd: string[],
  env: Record<string, string>
) => Promise<{ exitCode: number; stderr: string }>;

const bunSpawn: Spawner = async (cmd, env) => {
  const proc = Bun.spawn(cmd, {
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  return { exitCode: await proc.exited, stderr };
};

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** Postgres' identifier limit (NAMEDATALEN - 1), in bytes. */
const MAX_IDENTIFIER_BYTES = 63;

/**
 * A database name with an ASCII suffix, within Postgres' 63-byte identifier
 * limit: the name is cut by bytes, never inside a UTF-8 sequence (Postgres
 * would truncate a longer one itself, to a name that may be another's).
 */
export function suffixed(name: string, suffix: string): string {
  const room = MAX_IDENTIFIER_BYTES - Buffer.byteLength(suffix);
  let head = "";
  let bytes = 0;
  for (const char of name) {
    const size = Buffer.byteLength(char);
    if (bytes + size > room) break;
    head += char;
    bytes += size;
  }
  return `${head}${suffix}`;
}

/**
 * The restore's database side against DATABASE_URL's server: a scratch
 * database `<db>_restore` built by pg_restore (credentials through libpq's
 * env, never argv), swapped in by renaming (`<db>` → `<db>_pre_restore`,
 * scratch → `<db>`) in one transaction. Needs the role to be allowed to
 * create databases (the bundled Postgres' role is its superuser) and the
 * maintenance database `postgres`. The new database copies the old one's
 * owner, encoding and locale; database-level settings (ALTER DATABASE … SET)
 * and grants on the database itself are not carried over.
 */
export function pgRestoreDatabase(
  url: string,
  opts: { connect?: (url: string) => Sql; spawn?: Spawner } = {}
): RestoreDatabase {
  const connect =
    opts.connect ??
    ((u: string) => postgres(u, { max: 1, onnotice: () => {} }));
  const spawn = opts.spawn ?? bunSpawn;
  const target = decodeURIComponent(new URL(url).pathname.slice(1));
  const scratch = suffixed(target, "_restore");
  const previous = suffixed(target, "_pre_restore");
  // A name over 63 bytes is not what Postgres stores, and a cut one can come
  // out equal to the live name (`<55 a>_restore` → scratch `<55 a>_restore`).
  const distinctNames =
    Buffer.byteLength(target) <= MAX_IDENTIFIER_BYTES &&
    new Set([target, scratch, previous]).size === 3;
  const maintenance = new URL(url);
  maintenance.pathname = "/postgres";
  let admin: Sql | null = null;
  const sql = () => {
    admin ??= connect(maintenance.toString());
    return admin;
  };

  /**
   * After a swap whose COMMIT outcome is unknown: returns when it happened,
   * rethrows `cause` when it did not, SwapOutcomeUnknownError when even that
   * cannot be read.
   */
  async function swapOutcome(cause: unknown): Promise<void> {
    await admin?.end({ timeout: 0 }).catch(() => {});
    admin = null;
    let names: string[];
    try {
      names = (
        await sql()<{ datname: string }[]>`select datname from pg_database
          where datname in (${target}, ${scratch})`
      ).map((r) => r.datname);
    } catch (error) {
      throw new SwapOutcomeUnknownError((error as Error).message);
    }
    if (names.includes(target) && !names.includes(scratch)) return;
    if (names.includes(target) && names.includes(scratch)) throw cause;
    throw new SwapOutcomeUnknownError(`databases present: ${names.join(", ")}`);
  }

  return {
    async prepare(dumpPath) {
      if (!distinctNames) {
        throw new Error(
          `database name ${target} leaves no room for distinct scratch names`
        );
      }
      const [props] = await sql()<
        {
          enc: string;
          datcollate: string;
          datctype: string;
          datlocprovider: string;
          loc: string | null;
          owner: string;
        }[]
      >`select pg_encoding_to_char(encoding) as enc, datcollate, datctype,
          datlocprovider::text as datlocprovider,
          to_jsonb(d) ->> 'datlocale' as loc,
          pg_get_userbyid(datdba) as owner
        from pg_database d where datname = ${target}`;
      if (!props) throw new Error(`database ${target} not found`);
      // Leftovers of an earlier run that stopped half way.
      await sql().unsafe(`DROP DATABASE IF EXISTS ${ident(scratch)}`);
      await sql().unsafe(`DROP DATABASE IF EXISTS ${ident(previous)}`);
      const locale =
        props.datlocprovider === "i"
          ? ` LOCALE_PROVIDER icu ICU_LOCALE ${literal(props.loc ?? "")}`
          : props.datlocprovider === "b"
            ? ` LOCALE_PROVIDER builtin BUILTIN_LOCALE ${literal(props.loc ?? "")}`
            : "";
      await sql().unsafe(
        `CREATE DATABASE ${ident(scratch)} OWNER ${ident(props.owner)} TEMPLATE template0` +
          ` ENCODING ${literal(props.enc)} LC_COLLATE ${literal(props.datcollate)}` +
          ` LC_CTYPE ${literal(props.datctype)}${locale}`
      );
      const { exitCode, stderr } = await spawn(
        [
          "pg_restore",
          ...PG_RESTORE_FLAGS,
          "--exit-on-error",
          "-d",
          scratch,
          dumpPath,
        ],
        { ...pgEnv(url), PGDATABASE: scratch }
      );
      if (exitCode !== 0) {
        const last = stderr.trim().split("\n").at(-1) ?? "";
        throw new Error(`pg_restore exited ${exitCode}: ${last}`);
      }
    },

    async swap() {
      // The app is stopped; anything still connected (the CLI's own pool)
      // is disconnected so the rename can run. Retried a few times in case
      // a client reconnects in between.
      for (let attempt = 1; ; attempt++) {
        await sql()`select pg_terminate_backend(pid) from pg_stat_activity
          where datname = ${target} and pid <> pg_backend_pid()`;
        try {
          await sql().begin(async (tx) => {
            await tx.unsafe(
              `ALTER DATABASE ${ident(target)} RENAME TO ${ident(previous)}`
            );
            await tx.unsafe(
              `ALTER DATABASE ${ident(scratch)} RENAME TO ${ident(target)}`
            );
          });
          return;
        } catch (error) {
          // A server error (SQLSTATE) means the transaction rolled back;
          // anything else (the connection dropped, maybe after COMMIT was
          // sent) leaves the outcome to be read back from pg_database.
          const code = (error as { code?: string }).code;
          if (!(error instanceof postgres.PostgresError)) {
            await swapOutcome(error);
            return;
          }
          // 55006 object_in_use: someone connected again.
          if (code !== "55006" || attempt >= 10) throw error;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    },

    async dropPrevious() {
      await sql().unsafe(`DROP DATABASE IF EXISTS ${ident(previous)}`);
    },

    async close() {
      if (admin) await admin.end({ timeout: 5 });
      admin = null;
    },
  };
}
