// One instance backup: dump the database, mirror the Garage bucket, write the
// manifest, upload to the destination (or keep it local), apply retention and
// record the run in instance_backups. `opsdeck backup run` and the app worker
// both call runInstanceBackup.
//
// Layout (manifest.json is written and uploaded last, so a folder without one
// is incomplete):
//   opsdeck-backups/<instance>/<name>/        on the S3 destination
//   /var/lib/opsdeck/backups/<instance>/<name>/   locally
//   <name> = <YYYY-MM-DDTHHmmss.SSSZ>-<6 hex, random per run>-<version>
//     database.dump   pg_dump -Fc of DATABASE_URL
//     garage/<key>    every object of the app's Garage bucket
//     manifest.json
// Every backup is staged in the local folder first. After a successful upload
// the local copy is removed; when the upload fails it is kept (and counted by
// the local retention of 3). Retention never deletes the newest complete
// backup nor the current run's folder; incomplete folders (crashed runs) are
// deleted once they are older than 24 hours.
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, eq, gte, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { instanceBackups, instanceSettings } from "@/lib/db/schema";
import { OPSDECK_VERSION } from "@/lib/version";
import {
  type BackupDestination,
  garageSource,
  loadBackupDestination,
  type ObjectStore,
} from "./destination";
import {
  type BackupManifest,
  DATABASE_FILE,
  GARAGE_DIR,
  MANIFEST_FILE,
  secretsKeyFingerprint,
  serializeManifest,
} from "./manifest";
import {
  type RetentionKey,
  selectByCount,
  selectForDeletion,
  selectStaleIncomplete,
} from "./retention";

export const LOCAL_BACKUP_ROOT = "/var/lib/opsdeck/backups";
export const REMOTE_PREFIX = "opsdeck-backups/";
export const LOCAL_KEEP = 3;
/** A row still `running` after this long belongs to a crashed process. */
export const INTERRUPTED_AFTER_MS = 6 * 60 * 60 * 1000;

export type BackupTrigger = "schedule" | "manual" | "update";

/** Stable codes recorded in instance_backups.error_code. */
export type BackupErrorCode =
  | "backupSecretsKeyMissing"
  | "backupDestinationFailed"
  | "backupDumpFailed"
  | "backupGarageFailed"
  | "backupWriteFailed"
  | "backupUploadFailed"
  | "backupRecordFailed"
  | "backupInterrupted"
  | "backupFailed";

export class BackupError extends Error {
  constructor(
    readonly code: BackupErrorCode,
    detail?: string
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "BackupError";
  }
}

/** The run could not be recorded at all (e.g. the database is down). */
export class BackupRecordError extends Error {
  constructor(
    /** Where the run would have gone. */
    readonly location: "s3" | "local",
    detail: string
  ) {
    super(`backupFailed: ${detail}`);
    this.name = "BackupRecordError";
  }
}

export type BackupResult = {
  id: string;
  status: "succeeded" | "failed";
  location: "s3" | "local";
  /** S3 key prefix, or the folder under the local root; null when nothing was kept. */
  objectKey: string | null;
  errorCode: string | null;
};

export interface BackupRecorder {
  start(row: {
    trigger: BackupTrigger;
    version: string;
    location: "s3" | "local";
  }): Promise<string>;
  finish(
    id: string,
    patch: {
      status: "succeeded" | "failed";
      location: "s3" | "local";
      objectKey: string | null;
      sizeBytes: number | null;
      errorCode: string | null;
    }
  ): Promise<void>;
  /** Stores the key fingerprint the latest backup needs, for the admin to check. */
  recordFingerprint(fingerprint: string): Promise<void>;
  /** Marks rows still `running` that started before `before` as interrupted. */
  markInterrupted(before: Date): Promise<void>;
}

export interface BackupDeps {
  recorder: BackupRecorder;
  destination: () => Promise<BackupDestination | null>;
  /** The Garage bucket to mirror; null when Garage is not provisioned. */
  garage: ObjectStore | null;
  /** Writes the database dump to `filePath`. */
  dumpDatabase: (
    filePath: string
  ) => Promise<{ sha256: string; bytes: number }>;
  localRoot: string;
  instance: string;
  version: string;
  secretsKey: string | undefined;
  now: () => Date;
  /** Makes the folder name unique per run (6 hex characters). */
  runSuffix: () => string;
  /** Diagnostics (stderr in the CLI). Never given a secret. */
  log: (line: string) => void;
}

/** Folder name of a backup: `<YYYY-MM-DDTHHmmss.SSSZ>-<suffix>-<version>`. */
export function backupName(at: Date, suffix: string, version: string): string {
  const stamp = at.toISOString().replace(/[:]/g, "");
  return `${stamp}-${suffix}-${version.replace(/[^A-Za-z0-9.-]/g, "-")}`;
}

const NAME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.(\d{3}))?Z-/;

/** The time in a backup folder name, or null for anything else. */
export function parseBackupName(name: string): Date | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s, ms] = m.slice(1).map((v) => Number(v ?? 0));
  return new Date(Date.UTC(y ?? 0, (mo ?? 1) - 1, d, h, mi, s, ms));
}

/** The instance name in backup paths: COMPOSE_PROJECT_NAME, else "opsdeck". */
export function instanceName(env: NodeJS.ProcessEnv = process.env): string {
  const name = (env.COMPOSE_PROJECT_NAME ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-");
  return /[a-z0-9]/.test(name) ? name : "opsdeck";
}

/** libpq env for a connection URL, so no credential reaches argv. */
function pgEnv(url: string): Record<string, string> {
  const u = new URL(url);
  const sslmode = u.searchParams.get("sslmode");
  return {
    PATH: process.env.PATH ?? "",
    PGHOST: decodeURIComponent(u.hostname),
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
    ...(sslmode ? { PGSSLMODE: sslmode } : {}),
  };
}

/**
 * `pg_dump -Fc` of `url` streamed into `filePath` (through a .partial file),
 * hashing on the way.
 */
export async function pgDumpToFile(
  url: string,
  filePath: string
): Promise<{ sha256: string; bytes: number }> {
  const partial = `${filePath}.partial`;
  const proc = Bun.spawn(["pg_dump", "--format=custom"], {
    env: pgEnv(url),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(proc.stderr).text();
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    await pipeline(
      Readable.fromWeb(proc.stdout as never),
      new Transform({
        transform(chunk: Buffer, _encoding, done) {
          hash.update(chunk);
          bytes += chunk.length;
          done(null, chunk);
        },
      }),
      createWriteStream(partial)
    );
  } catch (error) {
    proc.kill();
    await proc.exited;
    throw new BackupError("backupDumpFailed", (error as Error).message);
  }
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const last = (await stderr).trim().split("\n").at(-1) ?? "";
    throw new BackupError(
      "backupDumpFailed",
      `pg_dump exited ${exitCode}: ${last}`
    );
  }
  await rename(partial, filePath);
  return { sha256: hash.digest("hex"), bytes };
}

export const dbBackupRecorder: BackupRecorder = {
  async start(row) {
    const [inserted] = await db
      .insert(instanceBackups)
      .values(row)
      .returning({ id: instanceBackups.id });
    if (!inserted) throw new Error("instance_backups insert returned no row");
    return inserted.id;
  },
  async finish(id, patch) {
    await db
      .update(instanceBackups)
      .set({ ...patch, finishedAt: new Date() })
      .where(eq(instanceBackups.id, id));
  },
  async recordFingerprint(fingerprint) {
    await db
      .update(instanceSettings)
      .set({ secretsKeyFingerprint: fingerprint })
      .where(eq(instanceSettings.id, 1));
  },
  async markInterrupted(before) {
    await db
      .update(instanceBackups)
      .set({
        status: "failed",
        errorCode: "backupInterrupted",
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(instanceBackups.status, "running"),
          lt(instanceBackups.startedAt, before)
        )
      );
  },
};

/**
 * True while another backup is in progress: a `running` row younger than
 * INTERRUPTED_AFTER_MS (an older one belongs to a crashed process). The
 * worker and the "Back up now" route check it so two backups never overlap.
 */
export async function isBackupRunning(
  now: Date = new Date()
): Promise<boolean> {
  const rows = await db
    .select({ id: instanceBackups.id })
    .from(instanceBackups)
    .where(
      and(
        eq(instanceBackups.status, "running"),
        gte(
          instanceBackups.startedAt,
          new Date(now.getTime() - INTERRUPTED_AFTER_MS)
        )
      )
    )
    .limit(1);
  return rows.length > 0;
}

function defaultDeps(): BackupDeps {
  return {
    recorder: dbBackupRecorder,
    destination: loadBackupDestination,
    garage: garageSource(),
    dumpDatabase: (filePath) => {
      const url = process.env.DATABASE_URL;
      if (!url)
        throw new BackupError("backupDumpFailed", "DATABASE_URL is not set");
      return pgDumpToFile(url, filePath);
    },
    localRoot: LOCAL_BACKUP_ROOT,
    instance: instanceName(),
    version: OPSDECK_VERSION,
    secretsKey: process.env.SECRETS_KEY,
    now: () => new Date(),
    runSuffix: () => randomBytes(3).toString("hex"),
    log: (line) => console.error(line),
  };
}

/** Runs `fn`, turning any error that is not already a BackupError into `code`. */
async function step<T>(
  code: BackupErrorCode,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError(code, describe(error));
  }
}

/** A short label for diagnostics: the error's name and first message line. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error).slice(0, 200);
  const first = error.message.split("\n")[0]?.slice(0, 200) ?? "";
  return `${error.name}${first ? ` ${first}` : ""}`;
}

/** Every file under `dir`, relative, "/"-separated. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join("/"));
}

/** Mirrors the Garage bucket into `garageDir`; returns its totals. */
async function mirrorGarage(
  garage: ObjectStore | null,
  garageDir: string
): Promise<{ objects: number; bytes: number }> {
  await mkdir(garageDir, { recursive: true });
  if (!garage) return { objects: 0, bytes: 0 };
  let objects = 0;
  let bytes = 0;
  for (const { key, size } of await garage.list("")) {
    // A zero-byte "folder/" marker holds no data.
    if (key.endsWith("/") && size === 0) continue;
    const target = resolve(garageDir, key);
    // Keys are app-generated uuid paths; refuse anything that would leave
    // the folder or cannot be a file.
    if (!target.startsWith(garageDir + sep) || key.endsWith("/")) {
      throw new BackupError("backupGarageFailed", "unsafe object key");
    }
    await mkdir(dirname(target), { recursive: true });
    bytes += await garage.download(key, target);
    objects += 1;
  }
  return { objects, bytes };
}

type Listed = { name: string; createdAt: Date; complete: boolean };

/** What retention deletes: superseded complete backups and stale incomplete ones. */
function doomedNames(
  listed: Listed[],
  current: string,
  now: Date,
  selectComplete: (keys: RetentionKey[]) => string[]
): string[] {
  const toKeys = (complete: boolean) =>
    listed
      .filter((l) => l.complete === complete)
      .map((l) => ({ key: l.name, createdAt: l.createdAt }));
  return [
    ...selectComplete(toKeys(true)),
    ...selectStaleIncomplete(toKeys(false), now),
  ].filter((name) => name !== current);
}

/** Local retention: the newest LOCAL_KEEP complete backups stay. */
async function applyLocalRetention(
  instanceDir: string,
  current: string,
  now: Date
): Promise<void> {
  const listed: Listed[] = [];
  for (const entry of await readdir(instanceDir, { withFileTypes: true })) {
    const createdAt = parseBackupName(entry.name);
    if (!entry.isDirectory() || !createdAt) continue;
    const complete = await stat(join(instanceDir, entry.name, MANIFEST_FILE))
      .then(() => true)
      .catch(() => false);
    listed.push({ name: entry.name, createdAt, complete });
  }
  for (const name of doomedNames(listed, current, now, (keys) =>
    selectByCount(keys, LOCAL_KEEP)
  )) {
    await rm(join(instanceDir, name), { recursive: true, force: true });
  }
}

/** Remote retention: the destination's daily and weekly counts. */
async function applyRemoteRetention(
  destination: BackupDestination,
  instancePrefix: string,
  current: string,
  now: Date
): Promise<void> {
  const byName = new Map<string, string[]>();
  for (const { key } of await destination.store.list(instancePrefix)) {
    const name = key.slice(instancePrefix.length).split("/")[0] ?? "";
    byName.set(name, [...(byName.get(name) ?? []), key]);
  }
  const listed: Listed[] = [];
  for (const [name, keys] of byName) {
    const createdAt = parseBackupName(name);
    if (!createdAt) continue;
    const complete = keys.includes(`${instancePrefix}${name}/${MANIFEST_FILE}`);
    listed.push({ name, createdAt, complete });
  }
  const doomed = doomedNames(listed, current, now, (keys) =>
    selectForDeletion(keys, destination.keepDaily, destination.keepWeekly)
  ).flatMap((name) => byName.get(name) ?? []);
  if (doomed.length > 0) await destination.store.delete(doomed);
}

type Outcome = {
  status: "succeeded" | "failed";
  location: "s3" | "local";
  objectKey: string | null;
  sizeBytes: number | null;
  error: unknown;
};

/**
 * Runs one backup and records it. Every failure after the row is created is
 * returned as a `failed` result; only a failure to create the row throws, as
 * a BackupRecordError carrying the location the run would have used.
 */
export async function runInstanceBackup(
  trigger: BackupTrigger,
  overrides: Partial<BackupDeps> = {}
): Promise<BackupResult> {
  const deps: BackupDeps = { ...defaultDeps(), ...overrides };
  const { recorder, log } = deps;
  const startedAt = deps.now();

  await recorder
    .markInterrupted(new Date(startedAt.getTime() - INTERRUPTED_AFTER_MS))
    .catch((e) => log(`backupInterruptedSweepFailed: ${describe(e)}`));

  let destination: BackupDestination | null = null;
  let destinationError: BackupError | null = null;
  try {
    destination = await deps.destination();
  } catch (error) {
    destinationError = new BackupError(
      "backupDestinationFailed",
      describe(error)
    );
  }
  const declared = destination || destinationError ? "s3" : "local";

  let id: string;
  try {
    id = await recorder.start({
      trigger,
      version: deps.version,
      location: declared,
    });
  } catch (error) {
    throw new BackupRecordError(declared, describe(error));
  }

  const outcome = await backUp(
    deps,
    startedAt,
    destination,
    destinationError
  ).catch(
    (error): Outcome => ({
      status: "failed",
      location: declared,
      objectKey: null,
      sizeBytes: null,
      error,
    })
  );

  let errorCode: string | null = null;
  if (outcome.status === "failed") {
    errorCode =
      outcome.error instanceof BackupError
        ? outcome.error.code
        : "backupFailed";
    log(
      outcome.error instanceof BackupError
        ? outcome.error.message
        : `${errorCode}: ${describe(outcome.error)}`
    );
  }
  let status = outcome.status;
  try {
    await recorder.finish(id, {
      status,
      location: outcome.location,
      objectKey: outcome.objectKey,
      sizeBytes: outcome.sizeBytes,
      errorCode,
    });
  } catch (error) {
    // The row stays `running`; the next run's sweep marks it interrupted.
    log(`backupRecordFailed: ${describe(error)}`);
    if (status === "succeeded") {
      status = "failed";
      errorCode = "backupRecordFailed";
    }
  }
  return {
    id,
    status,
    location: outcome.location,
    objectKey: outcome.objectKey,
    errorCode,
  };
}

/** Stages, uploads and applies retention; never records the row itself. */
async function backUp(
  deps: BackupDeps,
  startedAt: Date,
  destination: BackupDestination | null,
  destinationError: BackupError | null
): Promise<Outcome> {
  const { log } = deps;
  const name = backupName(startedAt, deps.runSuffix(), deps.version);
  const localKey = `${deps.instance}/${name}/`;
  const instancePrefix = `${REMOTE_PREFIX}${deps.instance}/`;
  const remoteKey = `${instancePrefix}${name}/`;
  const instanceDir = resolve(deps.localRoot, deps.instance);
  const dir = join(instanceDir, name);
  const declared = destination || destinationError ? "s3" : "local";

  // 1. Stage the backup in the local folder.
  let created = false;
  let sizeBytes: number;
  let fingerprint: string;
  try {
    if (!deps.secretsKey) throw new BackupError("backupSecretsKeyMissing");
    fingerprint = secretsKeyFingerprint(deps.secretsKey);
    await step("backupWriteFailed", async () => {
      await mkdir(instanceDir, { recursive: true });
      // Not recursive: a name collision fails instead of sharing a folder.
      await mkdir(dir);
      created = true;
    });
    const database = await step("backupDumpFailed", () =>
      deps.dumpDatabase(join(dir, DATABASE_FILE))
    );
    const garage = await step("backupGarageFailed", () =>
      mirrorGarage(deps.garage, join(dir, GARAGE_DIR))
    );
    const manifest: BackupManifest = {
      format: 1,
      version: deps.version,
      createdAt: startedAt.toISOString(),
      database: {
        file: DATABASE_FILE,
        sha256: database.sha256,
        bytes: database.bytes,
      },
      garage,
      secretsKeyFingerprint: fingerprint,
    };
    const manifestText = serializeManifest(manifest);
    await step("backupWriteFailed", () =>
      writeFile(join(dir, MANIFEST_FILE), manifestText)
    );
    sizeBytes = database.bytes + garage.bytes + Buffer.byteLength(manifestText);
  } catch (error) {
    // An incomplete folder is no use to anyone; never touch another run's.
    if (created)
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    return {
      status: "failed",
      location: declared,
      objectKey: null,
      sizeBytes: null,
      error,
    };
  }

  const localRetention = () =>
    applyLocalRetention(instanceDir, name, deps.now()).catch((e) =>
      log(`backupRetentionFailed: ${describe(e)}`)
    );
  const keptLocal = async (error: unknown): Promise<Outcome> => {
    await localRetention();
    return {
      status: "failed",
      location: "local",
      objectKey: localKey,
      sizeBytes,
      error,
    };
  };
  const rememberFingerprint = () =>
    deps.recorder
      .recordFingerprint(fingerprint)
      .catch((e) => log(`backupFingerprintFailed: ${describe(e)}`));

  if (destinationError) return keptLocal(destinationError);

  if (!destination) {
    await rememberFingerprint();
    await localRetention();
    return {
      status: "succeeded",
      location: "local",
      objectKey: localKey,
      sizeBytes,
      error: null,
    };
  }

  // 2. Upload: database.dump, garage/*, manifest.json last.
  const garageFiles = (await filesUnder(dir))
    .filter((f) => f !== DATABASE_FILE && f !== MANIFEST_FILE)
    .sort();
  const files = [DATABASE_FILE, ...garageFiles, MANIFEST_FILE];
  const uploaded: string[] = [];
  try {
    for (const file of files) {
      const key = `${remoteKey}${file}`;
      await destination.store.upload(key, join(dir, file));
      uploaded.push(key);
    }
  } catch (error) {
    // Best effort: a partial upload has no manifest and is never restored.
    await destination.store.delete(uploaded).catch(() => {});
    return keptLocal(new BackupError("backupUploadFailed", describe(error)));
  }

  // 3. The upload is complete: drop the local copy, then apply retention.
  await rm(dir, { recursive: true, force: true }).catch((e) =>
    log(`backupCleanupFailed: ${describe(e)}`)
  );
  await rememberFingerprint();
  await applyRemoteRetention(
    destination,
    instancePrefix,
    name,
    deps.now()
  ).catch((e) => log(`backupRetentionFailed: ${describe(e)}`));
  return {
    status: "succeeded",
    location: "s3",
    objectKey: remoteKey,
    sizeBytes,
    error: null,
  };
}
