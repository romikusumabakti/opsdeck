// New environment in a project with sources (its services): only those
// services are offered, and a picked one starts on the project's default
// branch. Pure: the route feeds it the service catalog and the project's
// sources.

export type NewEnvironmentSources = {
  /** The project's services; a registered repository of another is not offered. */
  serviceKeys: string[];
  /** The project default branch by service key, only where one is set. */
  defaultBranches: Record<string, string>;
};

/**
 * No sources: the whole catalog and null. Else only the project's services,
 * their keys, and the set defaults by service key.
 */
export function sourcesModeProps<S extends { componentKey: string }>(
  catalog: S[],
  sources: { componentKey: string; defaultBranch: string | null }[]
): { services: S[]; sources: NewEnvironmentSources | null } {
  if (sources.length === 0) return { services: catalog, sources: null };
  const serviceKeys = new Set(sources.map((s) => s.componentKey));
  const defaultBranches: Record<string, string> = {};
  for (const s of sources) {
    if (s.defaultBranch) defaultBranches[s.componentKey] = s.defaultBranch;
  }
  return {
    services: catalog.filter((s) => serviceKeys.has(s.componentKey)),
    sources: { serviceKeys: [...serviceKeys].sort(), defaultBranches },
  };
}
