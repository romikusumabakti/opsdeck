export const DB_KINDS = ["shared", "container", "external"] as const;
export type DbKind = (typeof DB_KINDS)[number];

const MAX_NAME_LENGTH = 63;

/**
 * Suggested database and role name for a shared binding:
 * `<project key lowercased>_<environment slug with - turned into _>`, kept to
 * what the server accepts (`^[a-z][a-z0-9_]{0,62}$`).
 */
export function suggestSharedDbName(
  projectKey: string,
  environmentSlug: string
): string {
  const clean = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  const key = clean(projectKey);
  const slug = clean(environmentSlug);
  return (slug ? `${key}_${slug}` : key).slice(0, MAX_NAME_LENGTH);
}

export type DatabaseBindingValues = {
  dbKind: DbKind | "";
  databaseHostId: string;
  dbRole: string;
  dbPasswordVariable: string;
};

/**
 * The binding fields that go into the environment payload. Only a shared
 * database carries a host, role and password variable (the server derives the
 * rest from the host). Container and external send just their kind, so moving
 * away from shared clears the host. An unset kind sends nothing.
 */
export function databaseBindingPayload(values: DatabaseBindingValues) {
  switch (values.dbKind) {
    case "shared":
      return {
        dbKind: "shared" as const,
        databaseHostId: values.databaseHostId,
        dbRole: values.dbRole.trim(),
        dbPasswordVariable: values.dbPasswordVariable.trim(),
      };
    case "container":
    case "external":
      return { dbKind: values.dbKind };
    default:
      return {};
  }
}
