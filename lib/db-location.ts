import type { Project } from "@/lib/db/schema";

// The subset of project fields that pin down where its backup files physically
// live: the same host (dbServerId), the same service instance (type + name, so
// the same container/pod for docker/kubernetes), and the same engine (dbType).
// Pure + client-safe (no server-only imports) so both the source-project picker
// and the restore action/worker can share one compatibility rule.
export type DbLocation = Pick<
  Project,
  "dbServerId" | "dbServiceType" | "dbServiceName" | "dbType"
>;

/**
 * True when two projects' backups sit in the same reachable filesystem — same
 * host, same DB service, same engine. When this holds, a restore run against
 * one project's DB server can read the other project's `dbBackupPath` directly,
 * with no host-to-host file transfer. Used to gate the "restore from another
 * project" source picker: a cross-server source would need the backup file
 * copied between hosts first, which is out of scope.
 */
export function dbLocationMatches(a: DbLocation, b: DbLocation): boolean {
  return (
    a.dbServerId === b.dbServerId &&
    a.dbServiceType === b.dbServiceType &&
    a.dbServiceName === b.dbServiceName &&
    a.dbType === b.dbType
  );
}
