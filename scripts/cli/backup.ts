// `opsdeck backup run [--trigger schedule|manual|update|restore]`: one instance
// backup to the configured S3 connection, or local when none is chosen.
// Prints the result as one JSON line; exits non-zero when it failed.
import type { BackupTrigger } from "@/lib/instance-backup/archive";

export const BACKUP_USAGE = `Usage: opsdeck backup run [--trigger schedule|manual|update|restore]
  (in the image: bun dist/cli.js backup run [--trigger …])

Dumps DATABASE_URL, mirrors the Garage bucket and uploads both with a
manifest to the backup destination chosen in Admin → Backups, or keeps them in
/var/lib/opsdeck/backups when none is chosen. The trigger defaults to manual.
Prints one JSON line {id,status,location,objectKey,errorCode}; exit 1 on failure.
While another backup runs, nothing is done: status "alreadyRunning", errorCode
"backupAlreadyRunning", exit 1. id is null then, and when the run could not be
recorded at all.`;

const TRIGGERS: readonly BackupTrigger[] = [
  "schedule",
  "manual",
  "update",
  "restore",
];

/** The trigger from `run [--trigger <t>]`, or null for invalid arguments. */
export function parseBackupArgs(args: string[]): BackupTrigger | null {
  const [sub, ...rest] = args;
  if (sub !== "run") return null;
  if (rest.length === 0) return "manual";
  if (rest.length !== 2 || rest[0] !== "--trigger") return null;
  const trigger = TRIGGERS.find((t) => t === rest[1]);
  return trigger ?? null;
}

export async function runBackup(args: string[]): Promise<number> {
  if (args.includes("--help")) {
    console.log(BACKUP_USAGE);
    return 0;
  }
  const trigger = parseBackupArgs(args);
  if (!trigger) {
    console.error(BACKUP_USAGE);
    return 1;
  }
  // Loaded here so `--help` needs neither a database nor SECRETS_KEY.
  const { BackupRecordError, runInstanceBackup } = await import(
    "@/lib/instance-backup/archive"
  );
  try {
    const result = await runInstanceBackup(trigger);
    console.log(JSON.stringify(result));
    return result.status === "succeeded" ? 0 : 1;
  } catch (error) {
    // The run could not even be recorded (e.g. the database is down).
    // runInstanceBackup only throws BackupRecordError, which carries the
    // location the run would have used (destination configured or failing →
    // "s3", none → "local"). Anything else failed before the destination was
    // read (setting up the run itself), so no destination is known and the
    // location is the one a run without a destination uses: "local".
    console.error(
      error instanceof BackupRecordError
        ? error.message
        : `backupFailed: ${(error as Error)?.name ?? "Error"}`
    );
    console.log(
      JSON.stringify({
        id: null,
        status: "failed",
        location: error instanceof BackupRecordError ? error.location : "local",
        objectKey: null,
        errorCode: "backupFailed",
      })
    );
    return 1;
  }
}
