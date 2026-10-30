import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, orFailure, type PostJson } from "@/web/api/client";

const routes = api.api.environments;
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

export async function listEnvironments() {
  return parseResponse(routes["list-environments"].$get());
}

export const listEnvironmentsQuery = (
  ...args: Parameters<typeof listEnvironments>
) =>
  queryOptions({
    queryKey: ["environments", "listEnvironments", args],
    queryFn: () => listEnvironments(...args),
  });

export async function getEnvironmentsLastOpened() {
  return parseResponse(routes["get-environments-last-opened"].$get());
}

export const getEnvironmentsLastOpenedQuery = (
  ...args: Parameters<typeof getEnvironmentsLastOpened>
) =>
  queryOptions({
    queryKey: ["environments", "getEnvironmentsLastOpened", args],
    queryFn: () => getEnvironmentsLastOpened(...args),
  });

export async function getEnvironmentById(id: string) {
  return parseResponse(routes["get-environment-by-id"].$get({ query: { id } }));
}

export const getEnvironmentByIdQuery = (
  ...args: Parameters<typeof getEnvironmentById>
) =>
  queryOptions({
    queryKey: ["environments", "getEnvironmentById", args],
    queryFn: () => getEnvironmentById(...args),
  });

export async function recordEnvironmentAccess(
  environmentId: Body<"record-environment-access">["environmentId"]
) {
  return parseResponse(
    routes["record-environment-access"].$post({ json: { environmentId } })
  );
}

export async function createEnvironment(
  data: Body<"create-environment">["data"]
) {
  return orFailure(
    () => parseResponse(routes["create-environment"].$post({ json: { data } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function updateEnvironment(
  id: Body<"update-environment">["id"],
  data: Body<"update-environment">["data"]
) {
  return orFailure(
    () =>
      parseResponse(routes["update-environment"].$post({ json: { id, data } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function deleteEnvironment(id: Body<"delete-environment">["id"]) {
  return orFailure(
    () => parseResponse(routes["delete-environment"].$post({ json: { id } })),
    (message) => ({ success: false, message }) as const
  );
}

/**
 * Page data: the environment behind `/<KEY>/<envSlug>` and the caller's
 * project role there. Rejects with a 404 ApiError when the key or slug is
 * unknown or the project is invisible to the caller.
 */
export async function resolveEnvironment(projectKey: string, envSlug: string) {
  return parseResponse(routes.resolve.$get({ query: { projectKey, envSlug } }));
}

export const resolveEnvironmentQuery = (
  ...args: Parameters<typeof resolveEnvironment>
) =>
  queryOptions({
    queryKey: ["environments", "resolveEnvironment", args],
    queryFn: () => resolveEnvironment(...args),
  });

export type EnvironmentListItem = Awaited<
  ReturnType<typeof listEnvironments>
>[number];
