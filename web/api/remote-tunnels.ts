import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api } from "@/web/api/client";

const routes = api.api["remote-tunnels"];

export const remoteTunnelsQuery = () =>
  queryOptions({
    queryKey: ["remote-tunnels", "list"],
    queryFn: () => parseResponse(routes.$get()),
  });

export async function registerRemoteTunnel(
  input: Parameters<typeof routes.$post>[0]["json"]
) {
  return parseResponse(routes.$post({ json: input }));
}

export async function deleteRemoteTunnel(id: string) {
  return parseResponse(routes[":id"].$delete({ param: { id } }));
}

async function listRemoteTunnels() {
  return parseResponse(routes.$get());
}

export type RemoteTunnelRow = Awaited<
  ReturnType<typeof listRemoteTunnels>
>[number];
