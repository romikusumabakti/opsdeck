// Whether Menara can create the Assistant's read-only login for an
// environment's database (Stage 9 spec F.2). Pure and client-safe: the
// service enforces it, the Database settings tab shows the reason. External
// databases and Postgres run by systemd are provisioned through the same
// admin paths as Menara's own (lib/assistant-db/provision).

export type AssistantDbUnavailableReason =
  // The db service lacks its engine or database name.
  | "incomplete"
  // sqlcmd and the MySQL client log in with the stored admin password.
  | "adminPasswordMissing";

export function assistantDbUnavailableReason(service: {
  dbKind: string | null;
  serviceType: string | null;
  dbType: string | null;
  dbName: string | null;
  hasAdminPassword: boolean;
}): AssistantDbUnavailableReason | null {
  if (!(service.dbType && service.dbName)) return "incomplete";
  if (service.dbType !== "postgres" && !service.hasAdminPassword) {
    return "adminPasswordMissing";
  }
  return null;
}
