import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api } from "@/web/api/client";

const routes = api.api["ci-connections"];

export async function listCiConnections() {
  return parseResponse(routes.$get());
}

export const listCiConnectionsQuery = () =>
  queryOptions({
    queryKey: ["ci-connections", "listCiConnections"],
    queryFn: listCiConnections,
  });

export async function updateCiConnection(
  id: string,
  changes: Parameters<(typeof routes)[":id"]["$patch"]>[0]["json"]
) {
  return parseResponse(routes[":id"].$patch({ param: { id }, json: changes }));
}

/** Checks the stored CI token and forge credentials (no values returned). */
export async function verifyCiConnection(id: string) {
  return parseResponse(routes[":id"].verify.$post({ param: { id } }));
}

export type CiConnectionCheck = Awaited<ReturnType<typeof verifyCiConnection>>;

export type CiConnectionRow = Awaited<
  ReturnType<typeof listCiConnections>
>[number];

/** The CI connections a registrant may register from (no URLs or tokens). */
export const ciConnectionOptionsQuery = () =>
  queryOptions({
    queryKey: ["ci-connections", "options"],
    queryFn: () => parseResponse(routes.options.$get()),
  });

export type CiConnectionOption = Awaited<
  ReturnType<
    NonNullable<ReturnType<typeof ciConnectionOptionsQuery>["queryFn"]>
  >
>[number];

/** A connection's repositories, each with a service it already builds. */
export const registrableReposQuery = (connectionId: string | null) =>
  queryOptions({
    queryKey: ["ci-connections", "repos", connectionId],
    queryFn: () =>
      parseResponse(
        routes[":id"].repos.$get({ param: { id: connectionId as string } })
      ),
    enabled: connectionId !== null,
    retry: false,
    staleTime: 60_000,
  });

export type RegistrableRepoRow = Awaited<
  ReturnType<NonNullable<ReturnType<typeof registrableReposQuery>["queryFn"]>>
>[number];
