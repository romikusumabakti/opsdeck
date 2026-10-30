import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, orFailure, type PostJson } from "@/web/api/client";

const routes = api.api.servers;
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

export async function getServers() {
  return parseResponse(routes["get-servers"].$get());
}

export const getServersQuery = (...args: Parameters<typeof getServers>) =>
  queryOptions({
    queryKey: ["servers", "getServers", args],
    queryFn: () => getServers(...args),
  });

export async function getServerById(id: string) {
  return parseResponse(routes["get-server-by-id"].$get({ query: { id } }));
}

export const getServerByIdQuery = (...args: Parameters<typeof getServerById>) =>
  queryOptions({
    queryKey: ["servers", "getServerById", args],
    queryFn: () => getServerById(...args),
  });

export async function getServerUsage(serverId: string) {
  return parseResponse(
    routes["get-server-usage"].$get({ query: { serverId } })
  );
}

export const getServerUsageQuery = (
  ...args: Parameters<typeof getServerUsage>
) =>
  queryOptions({
    queryKey: ["servers", "getServerUsage", args],
    queryFn: () => getServerUsage(...args),
  });

export async function createServer(data: Body<"create-server">["data"]) {
  return orFailure(
    () => parseResponse(routes["create-server"].$post({ json: { data } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function updateServer(
  id: Body<"update-server">["id"],
  data: Body<"update-server">["data"]
) {
  return orFailure(
    () => parseResponse(routes["update-server"].$post({ json: { id, data } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function testServerConnection(
  input: Body<"test-server-connection">["input"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["test-server-connection"].$post({ json: { input } })
      ),
    (message) => ({ ok: false, message }) as const
  );
}

export async function bulkDeleteServers(
  ids: Body<"bulk-delete-servers">["ids"]
) {
  return orFailure(
    () => parseResponse(routes["bulk-delete-servers"].$post({ json: { ids } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function deleteServer(id: Body<"delete-server">["id"]) {
  return orFailure(
    () => parseResponse(routes["delete-server"].$post({ json: { id } })),
    (message) => ({ success: false, message }) as const
  );
}
