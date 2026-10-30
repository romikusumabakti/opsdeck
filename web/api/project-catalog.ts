import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, orFailure, type PostJson } from "@/web/api/client";

const routes = api.api["project-catalog"];
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

export async function listProjects() {
  return parseResponse(routes["list-projects"].$get());
}

export const listProjectsQuery = (...args: Parameters<typeof listProjects>) =>
  queryOptions({
    queryKey: ["project-catalog", "listProjects", args],
    queryFn: () => listProjects(...args),
  });

export async function listProjectsWithEnvironments() {
  return parseResponse(routes["list-projects-with-environments"].$get());
}

export const listProjectsWithEnvironmentsQuery = (
  ...args: Parameters<typeof listProjectsWithEnvironments>
) =>
  queryOptions({
    queryKey: ["project-catalog", "listProjectsWithEnvironments", args],
    queryFn: () => listProjectsWithEnvironments(...args),
  });

export async function getProject(id: string) {
  return parseResponse(routes["get-project"].$get({ query: { id } }));
}

export const getProjectQuery = (...args: Parameters<typeof getProject>) =>
  queryOptions({
    queryKey: ["project-catalog", "getProject", args],
    queryFn: () => getProject(...args),
  });

export async function getProjectWithEnvironments(id: string) {
  return parseResponse(
    routes["get-project-with-environments"].$get({ query: { id } })
  );
}

export const getProjectWithEnvironmentsQuery = (
  ...args: Parameters<typeof getProjectWithEnvironments>
) =>
  queryOptions({
    queryKey: ["project-catalog", "getProjectWithEnvironments", args],
    queryFn: () => getProjectWithEnvironments(...args),
  });

export async function getProjectByKeyWithEnvironments(key: string) {
  return parseResponse(
    routes["get-project-by-key-with-environments"].$get({ query: { key } })
  );
}

export const getProjectByKeyWithEnvironmentsQuery = (
  ...args: Parameters<typeof getProjectByKeyWithEnvironments>
) =>
  queryOptions({
    queryKey: ["project-catalog", "getProjectByKeyWithEnvironments", args],
    queryFn: () => getProjectByKeyWithEnvironments(...args),
  });

export async function addProject(data: Body<"add-project">["data"]) {
  return orFailure(
    () => parseResponse(routes["add-project"].$post({ json: { data } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function editProject(
  id: Body<"edit-project">["id"],
  data: Body<"edit-project">["data"]
) {
  return orFailure(
    () => parseResponse(routes["edit-project"].$post({ json: { id, data } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function removeProject(id: Body<"remove-project">["id"]) {
  return orFailure(
    () => parseResponse(routes["remove-project"].$post({ json: { id } })),
    (message) => ({ success: false, message }) as const
  );
}

/** Page data: the caller's project roles (`{ all, roles }`). */
export async function getMyProjectAccess() {
  return parseResponse(routes["my-access"].$get());
}

export const getMyProjectAccessQuery = (
  ...args: Parameters<typeof getMyProjectAccess>
) =>
  queryOptions({
    queryKey: ["project-catalog", "getMyProjectAccess", args],
    queryFn: () => getMyProjectAccess(...args),
  });
