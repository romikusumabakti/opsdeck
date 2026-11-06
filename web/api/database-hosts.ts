import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api } from "@/web/api/client";

const routes = api.api["database-hosts"];

export async function listDatabaseHosts(serverId?: string) {
  return parseResponse(routes.$get({ query: serverId ? { serverId } : {} }));
}

export const listDatabaseHostsQuery = (
  ...args: Parameters<typeof listDatabaseHosts>
) =>
  queryOptions({
    queryKey: ["databaseHosts", "listDatabaseHosts", args],
    queryFn: () => listDatabaseHosts(...args),
  });

export async function createDatabaseHost(
  input: Parameters<typeof routes.$post>[0]["json"]
) {
  return parseResponse(routes.$post({ json: input }));
}

export async function deleteDatabaseHost(id: string) {
  return parseResponse(routes[":id"].$delete({ param: { id } }));
}

export type DatabaseHostRow = Awaited<
  ReturnType<typeof listDatabaseHosts>
>[number];
