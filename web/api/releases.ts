import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api } from "@/web/api/client";

const routes = api.api;

export async function listProjectReleases(projectId: string) {
  return parseResponse(
    routes.projects[":projectId"].releases.$get({ param: { projectId } })
  );
}

export const listProjectReleasesQuery = (
  ...args: Parameters<typeof listProjectReleases>
) =>
  queryOptions({
    queryKey: ["releases", "listProjectReleases", args],
    queryFn: () => listProjectReleases(...args),
  });

export type ProjectReleases = Awaited<ReturnType<typeof listProjectReleases>>;
export type ReleaseListItem = ProjectReleases["releases"][number];

export async function createRelease(
  environmentId: string,
  input: { deploymentId: string; version: string; notes?: string }
) {
  return parseResponse(
    routes.environments[":environmentId"].releases.$post({
      param: { environmentId },
      json: input,
    })
  );
}

export async function deleteRelease(id: string) {
  return parseResponse(routes.releases[":id"].$delete({ param: { id } }));
}

/** Where a ready release is downloaded from (a plain link: the API streams it). */
export const releaseDownloadHref = (id: string) =>
  `/api/releases/${id}/download`;
