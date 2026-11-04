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

export async function refreshCiExtensionKey(id: string) {
  return parseResponse(routes[":id"]["refresh-key"].$post({ param: { id } }));
}

export type CiConnectionRow = Awaited<
  ReturnType<typeof listCiConnections>
>[number];
