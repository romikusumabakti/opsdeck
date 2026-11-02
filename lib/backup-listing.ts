import { shq } from "@/lib/sh";
import type { Backup } from "@/lib/types";

/**
 * Lists the regular files of one directory as `name<TAB>size<TAB>mtime` lines
 * (size in bytes, mtime in epoch seconds). Bash (which buildDbShellCommand
 * always wraps it in) plus `stat -c`, which GNU coreutils and BusyBox both
 * have, so it also runs inside alpine containers (`find -printf` does not).
 * The files are collected in a bash array and passed to a single `stat`: a
 * stat per file took 18s for ~3000 mssql .bak files, past the SSH timeout.
 * A missing directory lists nothing; an empty one too (the trailing `true`
 * swallows the unmatched-glob status). The extension filter is applied by
 * `parseBackupListing`, not here.
 */
export function backupListCommand(directory: string): string {
  const dir = shq(directory);
  return (
    `[ -d ${dir} ] || exit 0; cd ${dir} || exit 1; ` +
    `files=(); for f in *; do [ -f "$f" ] && files+=("$f"); done; ` +
    `[ \${#files[@]} -eq 0 ] || { t=$(printf '\\t'); ` +
    `stat -c "%n$t%s$t%Y" -- "\${files[@]}"; }; true`
  );
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
