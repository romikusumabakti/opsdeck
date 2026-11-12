// New environment in a project with sources: only the source apps are
// offered, and a picked component starts on the project's default branch.
// Pure: the route feeds it the catalog and the project's sources.

export type NewEnvironmentSources = {
  /** The project's source apps; a registered repository of another app is not offered. */
  appKeys: string[];
  /** The project default branch by component key, only where one is set. */
  defaultBranches: Record<string, string>;
};

/** No sources: the whole catalog and null. Else only the source apps, their keys, and the set defaults by component key. */
export function sourcesModeProps<A extends { id: string }>(
  catalog: A[],
  sources: {
    appId: string;
    appKey: string;
    components: { componentKey: string; defaultBranch: string | null }[];
  }[]
): { apps: A[]; sources: NewEnvironmentSources | null } {
  if (sources.length === 0) return { apps: catalog, sources: null };
  const sourceAppIds = new Set(sources.map((s) => s.appId));
  const defaultBranches: Record<string, string> = {};
  for (const source of sources) {
    for (const c of source.components) {
      if (c.defaultBranch) defaultBranches[c.componentKey] = c.defaultBranch;
    }
  }
  return {
    apps: catalog.filter((app) => sourceAppIds.has(app.id)),
    sources: { appKeys: sources.map((s) => s.appKey), defaultBranches },
  };
}
