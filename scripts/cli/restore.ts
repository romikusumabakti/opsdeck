// `opsdeck restore <objectKey>`: replaces the instance's database and stored
// files with a backup. The host updater runs it with the app and terminal
// stopped, under the backup's version (lib/instance-backup/restore.ts has the
// steps, lib/updates/request.ts the exit-code contract).
import type { RestoreResult } from "@/lib/instance-backup/restore";
import {
  BACKUP_OBJECT_KEY_RE,
  RESTORE_REFUSED_EXIT,
} from "@/lib/updates/request";

export const RESTORE_USAGE = `Usage: opsdeck restore <objectKey>
  (in the image: bun dist/cli.js restore <objectKey>)

Restores an instance backup: an S3 key prefix on the backup destination
(opsdeck-backups/<instance>/<name>/) or local:<instance>/<name>/ in
/var/lib/opsdeck/backups. On a fresh install (no destination in the
database yet) an S3 key is read from OPSDECK_RESTORE_S3_ENDPOINT, _REGION,
_BUCKET, _ACCESS_KEY_ID, _SECRET_ACCESS_KEY and _FORCE_PATH_STYLE when set
(install.sh --restore s3://...). Stop the app and terminal first. The backup's
version must be the running one and SECRETS_KEY must be the one it was taken
with. Prints one JSON line {status,errorCode,version}.
Exit 0: restored. Exit ${RESTORE_REFUSED_EXIT}: refused, nothing was changed. Exit 1: failed
after the database was replaced.`;

/** The object key from the arguments, or null for anything else. */
export function parseRestoreArgs(args: string[]): string | null {
  if (args.length !== 1) return null;
  const [key] = args;
  return key !== undefined && BACKUP_OBJECT_KEY_RE.test(key) ? key : null;
}

export function restoreExitCode(status: RestoreResult["status"]): number {
  if (status === "restored") return 0;
  return status === "refused" ? RESTORE_REFUSED_EXIT : 1;
}

export async function runRestoreCommand(args: string[]): Promise<number> {
  if (args.includes("--help")) {
    console.log(RESTORE_USAGE);
    return 0;
  }
  const key = parseRestoreArgs(args);
  if (!key) {
    console.error(RESTORE_USAGE);
    // Nothing was touched: a refusal, so the updater puts the previous
    // images back.
    console.log(
      JSON.stringify({
        status: "refused",
        errorCode: "restoreNotFound",
        version: null,
      })
    );
    return RESTORE_REFUSED_EXIT;
  }
  // Loaded here so `--help` needs neither a database nor SECRETS_KEY.
  const [restore, archive, destination, { OPSDECK_VERSION }, { pgClient }] =
    await Promise.all([
      import("@/lib/instance-backup/restore"),
      import("@/lib/instance-backup/archive"),
      import("@/lib/instance-backup/destination"),
      import("@/lib/version"),
      import("@/lib/db"),
    ]);
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    console.log(
      JSON.stringify({
        status: "refused",
        errorCode: "restoreDatabaseFailed",
        version: null,
      })
    );
    return RESTORE_REFUSED_EXIT;
  }
  const result = await restore.runRestore(key, {
    version: OPSDECK_VERSION,
    secretsKey: process.env.SECRETS_KEY,
    async openSource(objectKey) {
      try {
        return await restore.openBackupSource(objectKey);
      } finally {
        // The destination is read from the live database before the swap;
        // closing the pool now leaves no connection on it then.
        await pgClient()
          .end({ timeout: 5 })
          .catch(() => {});
      }
    },
    garage: destination.garageSource(),
    database: restore.pgRestoreDatabase(url),
    stagingRoot: archive.LOCAL_BACKUP_ROOT,
    log: (line) => console.error(line),
  });
  console.log(JSON.stringify(result));
  return restoreExitCode(result.status);
}
