// New environment in a project with sources (its services): only the apps
// holding them are offered, and a picked component starts on the project's
// default branch.
// Pure: the route feeds it the catalog and the project's sources.

export type NewEnvironmentSources = {
  /** The project's source apps; a registered repository of another app is not offered. */
  appKeys: string[];
  /** The project default branch by component key, only where one is set. */
  defaultBranches: Record<string, string>;
};

/**
 * No sources: the whole catalog and null. Else only the apps holding one of
 * the project's services (until Task 3 the wizard still picks an app), their
 * keys, and the set defaults by service key.
 */
export function sourcesModeProps<
  A extends { appKey: string; components: readonly { componentKey: string }[] },
>(
  catalog: A[],
  sources: { componentKey: string; defaultBranch: string | null }[]
): { apps: A[]; sources: NewEnvironmentSources | null } {
  if (sources.length === 0) return { apps: catalog, sources: null };
  const serviceKeys = new Set(sources.map((s) => s.componentKey));
  const defaultBranches: Record<string, string> = {};
  for (const s of sources) {
    if (s.defaultBranch) defaultBranches[s.componentKey] = s.defaultBranch;
  }
  const apps = catalog.filter((app) =>
    app.components.some((c) => serviceKeys.has(c.componentKey))
  );
  return {
    apps,
    sources: { appKeys: apps.map((app) => app.appKey), defaultBranches },
  };
}
