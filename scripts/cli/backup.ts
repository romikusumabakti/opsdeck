// `opsdeck backup run [--trigger schedule|manual|update]`: one instance
// backup to the configured S3 connection, or local when none is chosen.
// Prints the result as one JSON line; exits non-zero when it failed.
import type { BackupTrigger } from "@/lib/instance-backup/archive";

export const BACKUP_USAGE = `Usage: opsdeck backup run [--trigger schedule|manual|update]
  (in the image: bun dist/cli.js backup run [--trigger …])

Dumps DATABASE_URL, mirrors the Garage bucket and uploads both with a
manifest to the backup destination chosen in Admin → Backups, or keeps them in
/var/lib/opsdeck/backups when none is chosen. The trigger defaults to manual.
Prints one JSON line {id,status,location,objectKey,errorCode}; exit 1 on failure.`;

const TRIGGERS: readonly BackupTrigger[] = ["schedule", "manual", "update"];

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
  const { runInstanceBackup } = await import("@/lib/instance-backup/archive");
  try {
    const result = await runInstanceBackup(trigger);
    console.log(JSON.stringify(result));
    return result.status === "succeeded" ? 0 : 1;
  } catch (error) {
    // The run could not even be recorded (e.g. the database is down).
    console.error(`backupFailed: ${(error as Error)?.name ?? "Error"}`);
    console.log(
      JSON.stringify({
        id: null,
        status: "failed",
        location: null,
        objectKey: null,
        errorCode: "backupFailed",
      })
    );
    return 1;
  }
}
