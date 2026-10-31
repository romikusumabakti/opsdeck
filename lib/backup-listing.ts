import { shq } from "@/lib/sh";
import type { Backup } from "@/lib/types";

/**
 * Lists the regular files of one directory as `name<TAB>size<TAB>mtime` lines
 * (mtime in epoch seconds), one `find` call, so no `ls` column parsing and
 * file names with spaces survive. GNU find only, which every supported DB host
 * and container image ships. The extension filter is applied by
 * `parseBackupListing`, not here.
 */
export function backupListCommand(directory: string): string {
  return `find ${shq(directory)} -maxdepth 1 -type f -printf '%f\\t%s\\t%T@\\n'`;
}

/**
 * Parses `backupListCommand` output into backups, newest first. Lines that are
 * malformed, or whose name does not end with `extensionPattern` (a regex
 * source, see dbBackupExtensionPattern), are skipped.
 */
export function parseBackupListing(
  output: string,
  extensionPattern: string
): Backup[] {
  const extension = new RegExp(`${extensionPattern}$`);
  const backups: Backup[] = [];
  for (const line of output.split("\n")) {
    const [name, size, mtime, ...rest] = line.replace(/\r$/, "").split("\t");
    if (!name || rest.length > 0 || !extension.test(name)) continue;
    const bytes = Number(size);
    const seconds = Number(mtime);
    if (
      !size ||
      !mtime ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      !Number.isFinite(seconds)
    ) {
      continue;
    }
    backups.push({
      name,
      size: bytes,
      modifiedAt: new Date(Math.floor(seconds * 1000)).toISOString(),
    });
  }
  return backups.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}
