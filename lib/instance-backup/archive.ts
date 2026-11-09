// One instance backup: dump the database, mirror the Garage bucket, write the
// manifest, upload to the destination (or keep it local), apply retention and
// record the run in instance_backups. `opsdeck backup run` and the app worker
// both call runInstanceBackup.
//
// Layout (manifest.json is written and uploaded last, so a folder without one
// is incomplete):
//   opsdeck-backups/<instance>/<YYYY-MM-DDTHHmmssZ>-<version>/   on the S3 destination
//   /var/lib/opsdeck/backups/<instance>/<same>/                   locally
//     database.dump   pg_dump -Fc of DATABASE_URL
//     garage/<key>    every object of the app's Garage bucket
//     manifest.json
// Every backup is staged in the local folder first. After a successful upload
// the local copy is removed; when the upload fails it is kept (and counted by
// the local retention of 3).
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { eq } from "drizzle-orm";
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
} from "./retention";

export const LOCAL_BACKUP_ROOT = "/var/lib/opsdeck/backups";
export const REMOTE_PREFIX = "opsdeck-backups/";
export const LOCAL_KEEP = 3;

export type BackupTrigger = "schedule" | "manual" | "update";

/** Stable codes recorded in instance_backups.error_code. */
export type BackupErrorCode =
  | "backupSecretsKeyMissing"
  | "backupDestinationFailed"
  | "backupDumpFailed"
  | "backupGarageFailed"
  | "backupWriteFailed"
  | "backupUploadFailed"
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
  /** Diagnostics (stderr in the CLI). Never given a secret. */
  log: (line: string) => void;
}

/** Folder name of a backup: `<YYYY-MM-DDTHHmmssZ>-<version>`. */
export function backupName(at: Date, version: string): string {
  const stamp = at
    .toISOString()
    .replace(/[:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${version.replace(/[^A-Za-z0-9.-]/g, "-")}`;
}

const NAME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z-/;

/** The time in a backup folder name, or null for anything else. */
export function parseBackupName(name: string): Date | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as number[];
  return new Date(Date.UTC(y ?? 0, (mo ?? 1) - 1, d, h, mi, s));
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
};

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
    log: (line) => console.error(line),
  };
}

/** Runs `step`, turning any error that is not already a BackupError into `code`. */
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
  for (const { key } of await garage.list("")) {
    const target = resolve(garageDir, key);
    // Keys are app-generated uuid paths; refuse anything that would leave
    // the folder or collide with a directory.
    if (!target.startsWith(garageDir + sep) || key.endsWith("/")) {
      throw new BackupError("backupGarageFailed", "unsafe object key");
    }
    await mkdir(dirname(target), { recursive: true });
    bytes += await garage.download(key, target);
    objects += 1;
  }
  return { objects, bytes };
}

/** Deletes complete local backups beyond the newest LOCAL_KEEP. */
async function applyLocalRetention(instanceDir: string): Promise<void> {
  const keys: RetentionKey[] = [];
  for (const entry of await readdir(instanceDir, { withFileTypes: true })) {
    const createdAt = parseBackupName(entry.name);
    if (!entry.isDirectory() || !createdAt) continue;
    const complete = await stat(join(instanceDir, entry.name, MANIFEST_FILE))
      .then(() => true)
      .catch(() => false);
    if (complete) keys.push({ key: entry.name, createdAt });
  }
  for (const name of selectByCount(keys, LOCAL_KEEP)) {
    await rm(join(instanceDir, name), { recursive: true, force: true });
  }
}

/** Deletes complete remote backups the destination's retention lets go. */
async function applyRemoteRetention(
  destination: BackupDestination,
  instancePrefix: string
): Promise<void> {
  const byName = new Map<string, string[]>();
  for (const { key } of await destination.store.list(instancePrefix)) {
    const name = key.slice(instancePrefix.length).split("/")[0] ?? "";
    byName.set(name, [...(byName.get(name) ?? []), key]);
  }
  const complete: RetentionKey[] = [];
  for (const [name, keys] of byName) {
    const createdAt = parseBackupName(name);
    if (
      createdAt &&
      keys.includes(`${instancePrefix}${name}/${MANIFEST_FILE}`)
    ) {
      complete.push({ key: name, createdAt });
    }
  }
  const doomed = selectForDeletion(
    complete,
    destination.keepDaily,
    destination.keepWeekly
  ).flatMap((name) => byName.get(name) ?? []);
  if (doomed.length > 0) await destination.store.delete(doomed);
}

export async function runInstanceBackup(
  trigger: BackupTrigger,
  overrides: Partial<BackupDeps> = {}
): Promise<BackupResult> {
  const deps: BackupDeps = { ...defaultDeps(), ...overrides };
  const { recorder, log } = deps;

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

  const name = backupName(deps.now(), deps.version);
  const localKey = `${deps.instance}/${name}/`;
  const instancePrefix = `${REMOTE_PREFIX}${deps.instance}/`;
  const remoteKey = `${instancePrefix}${name}/`;
  const instanceDir = resolve(deps.localRoot, deps.instance);
  const dir = join(instanceDir, name);

  const id = await recorder.start({
    trigger,
    version: deps.version,
    location: destination || destinationError ? "s3" : "local",
  });

  const fail = async (
    error: unknown,
    kept: {
      location: "s3" | "local";
      objectKey: string | null;
      sizeBytes: number | null;
    }
  ): Promise<BackupResult> => {
    const code = error instanceof BackupError ? error.code : "backupFailed";
    log(
      error instanceof BackupError
        ? error.message
        : `${code}: ${describe(error)}`
    );
    await recorder.finish(id, { status: "failed", errorCode: code, ...kept });
    return {
      id,
      status: "failed",
      location: kept.location,
      objectKey: kept.objectKey,
      errorCode: code,
    };
  };

  // 1. Stage the backup in the local folder.
  let sizeBytes: number;
  let fingerprint: string;
  try {
    if (!deps.secretsKey) throw new BackupError("backupSecretsKeyMissing");
    fingerprint = secretsKeyFingerprint(deps.secretsKey);
    await step("backupWriteFailed", () => mkdir(dir, { recursive: true }));
    const database = await step("backupDumpFailed", () =>
      deps.dumpDatabase(join(dir, DATABASE_FILE))
    );
    const garage = await step("backupGarageFailed", () =>
      mirrorGarage(deps.garage, join(dir, GARAGE_DIR))
    );
    const manifest: BackupManifest = {
      format: 1,
      version: deps.version,
      createdAt: deps.now().toISOString(),
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
    // An incomplete folder is no use to anyone.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return fail(error, {
      location: destination || destinationError ? "s3" : "local",
      objectKey: null,
      sizeBytes: null,
    });
  }

  const keepLocal = async (error: unknown) => {
    await applyLocalRetention(instanceDir).catch((e) =>
      log(`backupRetentionFailed: ${describe(e)}`)
    );
    return fail(error, { location: "local", objectKey: localKey, sizeBytes });
  };

  if (destinationError) return keepLocal(destinationError);

  if (!destination) {
    await recorder
      .recordFingerprint(fingerprint)
      .catch((e) => log(`backupFingerprintFailed: ${describe(e)}`));
    await applyLocalRetention(instanceDir).catch((e) =>
      log(`backupRetentionFailed: ${describe(e)}`)
    );
    await recorder.finish(id, {
      status: "succeeded",
      location: "local",
      objectKey: localKey,
      sizeBytes,
      errorCode: null,
    });
    return {
      id,
      status: "succeeded",
      location: "local",
      objectKey: localKey,
      errorCode: null,
    };
  }

  // 2. Upload, manifest last.
  const files = (await filesUnder(dir))
    .filter((f) => f !== MANIFEST_FILE)
    .sort((a, b) =>
      a === DATABASE_FILE
        ? -1
        : b === DATABASE_FILE
          ? 1
          : a < b
            ? -1
            : a > b
              ? 1
              : 0
    );
  files.push(MANIFEST_FILE);
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
    return keepLocal(new BackupError("backupUploadFailed", describe(error)));
  }

  // 3. The upload is complete: drop the local copy, then apply retention.
  await rm(dir, { recursive: true, force: true }).catch((e) =>
    log(`backupCleanupFailed: ${describe(e)}`)
  );
  await recorder
    .recordFingerprint(fingerprint)
    .catch((e) => log(`backupFingerprintFailed: ${describe(e)}`));
  await applyRemoteRetention(destination, instancePrefix).catch((e) =>
    log(`backupRetentionFailed: ${describe(e)}`)
  );
  await recorder.finish(id, {
    status: "succeeded",
    location: "s3",
    objectKey: remoteKey,
    sizeBytes,
    errorCode: null,
  });
  return {
    id,
    status: "succeeded",
    location: "s3",
    objectKey: remoteKey,
    errorCode: null,
  };
}
