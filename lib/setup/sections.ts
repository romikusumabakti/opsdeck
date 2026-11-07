export type SectionName =
  | "server"
  | "database"
  | "variables"
  | "domain"
  | "deploy";

/**
 * The section whose fields a setup issue's path belongs to, if any. Shared by
 * the section forms (issue badges) and the Review (issue labels).
 */
export function sectionOfField(field: string): SectionName | null {
  if (field === "server.serverId" || field.startsWith("services")) {
    return "server";
  }
  if (field.startsWith("database")) return "database";
  if (field.startsWith("variables")) return "variables";
  if (field.startsWith("domain")) return "domain";
  if (field.startsWith("targets")) return "deploy";
  return null;
}
