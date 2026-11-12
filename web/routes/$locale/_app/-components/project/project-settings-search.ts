export const PROJECT_SETTINGS_TABS = [
  "details",
  "jira",
  "members",
  "danger",
] as const;
export type ProjectSettingsTab = (typeof PROJECT_SETTINGS_TABS)[number];

/** The Project settings page's search params: the open tab. */
export function projectSettingsSearch(search: Record<string, unknown>): {
  tab?: ProjectSettingsTab;
} {
  return PROJECT_SETTINGS_TABS.includes(search.tab as ProjectSettingsTab)
    ? { tab: search.tab as ProjectSettingsTab }
    : {};
}

/**
 * The tab to show: the requested one, or "details" when it is missing or the
 * caller may not open it (a stale or hand-typed `?tab=`).
 */
export function visibleSettingsTab(
  tab: ProjectSettingsTab | undefined,
  allowed: { members: boolean; danger: boolean }
): ProjectSettingsTab {
  if (tab === "members" && !allowed.members) return "details";
  if (tab === "danger" && !allowed.danger) return "details";
  return tab ?? "details";
}
