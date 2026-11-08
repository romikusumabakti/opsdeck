import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import {
  ApiError,
  api,
  NO_REFETCH,
  orFailure,
  type PostJson,
} from "@/web/api/client";

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

/**
 * Bookkeeping (the switcher's and Home's recency order): skips the refetch
 * after a mutation, since nothing on the current screen shows it.
 */
export async function recordEnvironmentAccess(
  environmentId: Body<"record-environment-access">["environmentId"]
) {
  return parseResponse(
    routes["record-environment-access"].$post(
      { json: { environmentId } },
      NO_REFETCH
    )
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

/**
 * `escrowed` is true when the delete was refused because the environment has
 * escrowed variables (409); an admin may then repeat it with
 * `confirmEscrowedDeletion`.
 */
export async function deleteEnvironment(
  id: Body<"delete-environment">["id"],
  confirmEscrowedDeletion?: boolean
): Promise<{ success: boolean; message?: string; escrowed?: boolean }> {
  try {
    return await parseResponse(
      routes["delete-environment"].$post({
        json: { id, confirmEscrowedDeletion },
      })
    );
  } catch (error) {
    if (error instanceof ApiError && error.status !== 401) {
      return {
        success: false,
        message: error.message,
        escrowed: error.status === 409,
      };
    }
    throw error;
  }
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

/** An environment with its services as the API sends it (dates as ISO strings). */
export type EnvironmentWithServers = NonNullable<
  Awaited<ReturnType<typeof getEnvironmentById>>
>;
