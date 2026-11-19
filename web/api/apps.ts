import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api } from "@/web/api/client";

const routes = api.api.apps;

export async function listApps() {
  return parseResponse(routes.$get());
}

export const listAppsQuery = () =>
  queryOptions({ queryKey: ["apps", "listApps"], queryFn: listApps });

export type AppRow = Awaited<ReturnType<typeof listApps>>[number];
export type AppComponentRow = AppRow["components"][number];

/**
 * Where "Add environment" for an app goes: the New environment page, with
 * the app's repository preselected, of `projectKey` or else of the one
 * project that holds the app's environments; with no such project, the
 * projects list, which says to pick one.
 */
export function addEnvironmentHref(
  app: { id: string; components: readonly { repoFullName: string }[] },
  projects: readonly {
    key: string;
    environments: readonly { appId: string | null }[];
  }[],
  projectKey?: string
): string {
  const holding = projects.filter((p) =>
    p.environments.some((e) => e.appId === app.id)
  );
  const target =
    projects.find((p) => p.key === projectKey?.toUpperCase()) ??
    (holding.length === 1 ? holding[0] : undefined);
  if (!target) return "/projects?newEnvironment=1";
  const repo = app.components[0]?.repoFullName;
  const query = repo ? `?repo=${encodeURIComponent(repo)}` : "";
  return `/${target.key}/environments/new${query}`;
}
