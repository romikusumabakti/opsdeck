import {
  keepPreviousData,
  queryOptions,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import type { BuildSpec } from "@/lib/ci/build-spec";
import type { RegisterAppInput } from "@/lib/ci/registration";
import { canOrg, canRegisterApp } from "@/lib/permissions";
import { api } from "@/web/api/client";
import { getMyProjectAccessQuery } from "@/web/api/project-catalog";
import { useMe } from "@/web/api/session";

const routes = api.api.apps;
const connections = api.api["ci-connections"];

export async function listApps() {
  return parseResponse(routes.$get());
}

export const listAppsQuery = () =>
  queryOptions({ queryKey: ["apps", "listApps"], queryFn: listApps });

export type AppRow = Awaited<ReturnType<typeof listApps>>[number];
export type AppComponentRow = AppRow["components"][number];

export async function registerApp(input: RegisterAppInput) {
  return parseResponse(routes.$post({ json: input }));
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

export async function listCiConnectionOptions() {
  return parseResponse(connections.options.$get());
}

export const listCiConnectionOptionsQuery = () =>
  queryOptions({
    queryKey: ["ci-connections", "options"],
    queryFn: listCiConnectionOptions,
  });

export async function listConnectionRepos(id: string) {
  return parseResponse(connections[":id"].repos.$get({ param: { id } }));
}

export const listConnectionReposQuery = (id: string | null) =>
  queryOptions({
    queryKey: ["ci-connections", "repos", id],
    queryFn: () => listConnectionRepos(id as string),
    enabled: id !== null,
    // Woodpecker's list changes rarely; a remount should not refetch it.
    staleTime: 60_000,
  });

export type RegistrableRepoRow = Awaited<
  ReturnType<typeof listConnectionRepos>
>[number];

/**
 * Whether the caller may register apps with custom pipelines (admins and
 * project maintainers). The page loader must have loaded
 * getMyProjectAccessQuery; the app shell always has.
 */
export function useCanRegisterApp(): boolean {
  const me = useMe();
  const access = useSuspenseQuery(getMyProjectAccessQuery()).data;
  return canRegisterApp(me?.orgRole, Object.values(access.roles));
}

/**
 * Whether the caller may use generated pipelines, commit pipeline files and
 * rotate notify secrets (org integration:manage, i.e. admins).
 */
export function useCanManagePipelines(): boolean {
  return canOrg(useMe()?.orgRole, { integration: ["manage"] });
}
