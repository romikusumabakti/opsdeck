import type { EnvironmentService } from "@/lib/db/schema";

// The subset of a db service's fields that pin down where its backup files
// physically live: the same host (serverId), the same service instance (type +
// name, so the same container/pod for docker/kubernetes), and the same engine
// (dbType). Pure + client-safe (no server-only imports) so both the source
// picker and the restore action/worker can share one compatibility rule.
export type DbLocation = Pick<
  EnvironmentService,
  "serverId" | "serviceType" | "serviceName" | "dbType"
>;

/**
 * True when two projects' backups sit in the same reachable filesystem — same
 * host, same DB service, same engine. When this holds, a restore run against
 * one environment's DB server can read the other environment's `dbBackupPath` directly,
 * with no host-to-host file transfer. Used to gate the "restore from another
 * environment" source picker: a cross-server source would need the backup file
 * copied between hosts first, which is out of scope.
 */
export function dbLocationMatches(a: DbLocation, b: DbLocation): boolean {
  return (
    a.serverId === b.serverId &&
    a.serviceType === b.serviceType &&
    a.serviceName === b.serviceName &&
    a.dbType === b.dbType
  );
}
