import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import type { BuildSpec } from "@/lib/ci/build-spec";
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

export async function rotateNotifySecret(appKey: string, componentKey: string) {
  return parseResponse(
    routes[":appKey"].components[":componentKey"]["rotate-secret"].$post({
      param: { appKey, componentKey },
    })
  );
}

/** Commits the generated pipeline file to every built branch, or to one. */
export async function commitPipelineFile(
  appKey: string,
  componentKey: string,
  branch?: string
) {
  return parseResponse(
    routes[":appKey"].components[":componentKey"]["commit-pipeline-file"].$post(
      {
        param: { appKey, componentKey },
        query: branch === undefined ? {} : { branch },
      }
    )
  );
}

export async function getPipelinePreview(
  componentKey: string,
  buildSpec: BuildSpec
) {
  return parseResponse(
    routes["pipeline-preview"].$get({
      query: { q: JSON.stringify({ componentKey, buildSpec }) },
    })
  );
}

/** The generated YAML for a valid spec; keeps the last one while typing. */
export const pipelinePreviewQuery = (
  componentKey: string,
  buildSpec: BuildSpec | null
) =>
  queryOptions({
    queryKey: ["apps", "pipelinePreview", componentKey, buildSpec],
    queryFn: () => getPipelinePreview(componentKey, buildSpec as BuildSpec),
    enabled: buildSpec !== null,
    placeholderData: keepPreviousData,
  });
