// Whether the Panel can create the Assistant's read-only login for an
// environment's database (Stage 9 spec F.2). Pure and client-safe: the
// service enforces it, the Database settings tab shows the reason.

export type AssistantDbUnavailableReason =
  // A server the Panel does not manage: it has no admin path there.
  | "external"
  // The db service lacks its engine or database name.
  | "incomplete"
  // sqlcmd and the MySQL client log in with the stored admin password.
  | "adminPasswordMissing"
  // Postgres run by systemd: the Panel reaches it as the `postgres` OS user
  // over the local socket, where peer authentication only lets a role of
  // that same name in, never the separate read-only role.
  | "peerAuth";

export function assistantDbUnavailableReason(service: {
  dbKind: string | null;
  serviceType: string | null;
  dbType: string | null;
  dbName: string | null;
  hasAdminPassword: boolean;
}): AssistantDbUnavailableReason | null {
  if (service.dbKind === "external") return "external";
  if (!(service.dbType && service.dbName)) return "incomplete";
  if (service.dbType !== "postgres" && !service.hasAdminPassword) {
    return "adminPasswordMissing";
  }
  if (service.dbType === "postgres" && service.serviceType === "systemd") {
    return "peerAuth";
  }
  return null;
}
