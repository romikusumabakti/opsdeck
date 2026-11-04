import type { ServiceRole } from "@/lib/services";

export type EnvSection = "databases" | "mockTime";

/**
 * The sidebar sections that only make sense when the environment has a given
 * service: Databases needs a `db` service, Mock time needs a `backend` one.
 */
export function visibleEnvSections(env: {
  services: { role: ServiceRole }[];
}): Set<EnvSection> {
  const roles = new Set(env.services.map((s) => s.role));
  const sections = new Set<EnvSection>();
  if (roles.has("db")) sections.add("databases");
  if (roles.has("backend")) sections.add("mockTime");
  return sections;
}
