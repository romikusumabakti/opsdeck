import {
  keepPreviousData,
  queryOptions,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import type { BuildSpec } from "@/lib/ci/build-spec";
import { canOrg, canProject, type ProjectRole } from "@/lib/permissions";
import { api } from "@/web/api/client";
import { getMyProjectAccessQuery } from "@/web/api/project-catalog";
import { useMe } from "@/web/api/session";

const routes = api.api.apps;

export async function listApps() {
  return parseResponse(routes.$get());
}

export const listAppsQuery = () =>
  queryOptions({ queryKey: ["apps", "listApps"], queryFn: listApps });

export type AppRow = Awaited<ReturnType<typeof listApps>>[number];
export type AppComponentRow = AppRow["components"][number];

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

/**
 * Whether the caller may use generated pipelines, commit pipeline files and
 * rotate notify secrets (org integration:manage, i.e. admins).
 */
export function useCanManagePipelines(): boolean {
  return canOrg(useMe()?.orgRole, { integration: ["manage"] });
}

/** The projects the caller may create environments in (engineers, admins). */
export function projectsToAddEnvironmentTo<T extends { id: string }>(
  projects: readonly T[],
  roles: Record<string, ProjectRole>
): T[] {
  return projects.filter((p) =>
    canProject(roles[p.id] ?? null, { environment: ["create"] })
  );
}

/**
 * Whether the caller may add an environment to an app: they can create
 * environments in some project. The page loader must have loaded
 * getMyProjectAccessQuery; the app shell always has.
 */
export function useCanAddEnvironment(): boolean {
  const access = useSuspenseQuery(getMyProjectAccessQuery()).data;
  return (
    projectsToAddEnvironmentTo(
      Object.keys(access.roles).map((id) => ({ id })),
      access.roles
    ).length > 0
  );
}
