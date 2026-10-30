import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, orFailure, type PostJson } from "@/web/api/client";
import { REMOTE_PROBE } from "@/web/query-client";

const routes = api.api.tunnels;
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

export async function getCloudflareZones() {
  return parseResponse(routes["get-cloudflare-zones"].$get());
}

export const getCloudflareZonesQuery = (
  ...args: Parameters<typeof getCloudflareZones>
) =>
  queryOptions({
    queryKey: ["tunnels", "getCloudflareZones", args],
    queryFn: () => getCloudflareZones(...args),
  });

export async function getTunnels() {
  return parseResponse(routes["get-tunnels"].$get());
}

export const getTunnelsQuery = (...args: Parameters<typeof getTunnels>) =>
  queryOptions({
    queryKey: ["tunnels", "getTunnels", args],
    queryFn: () => getTunnels(...args),
  });

export async function getTunnel(id: string) {
  return parseResponse(routes["get-tunnel"].$get({ query: { id } }));
}

export const getTunnelQuery = (...args: Parameters<typeof getTunnel>) =>
  queryOptions({
    queryKey: ["tunnels", "getTunnel", args],
    queryFn: () => getTunnel(...args),
  });

export async function getTunnelRoutes(id: string) {
  return parseResponse(routes["get-tunnel-routes"].$get({ query: { id } }));
}

export const getTunnelRoutesQuery = (
  ...args: Parameters<typeof getTunnelRoutes>
) =>
  queryOptions({
    queryKey: ["tunnels", "getTunnelRoutes", args],
    queryFn: () => getTunnelRoutes(...args),
    ...REMOTE_PROBE,
  });

export async function getOriginCandidates(id: string) {
  return parseResponse(routes["get-origin-candidates"].$get({ query: { id } }));
}

export const getOriginCandidatesQuery = (
  ...args: Parameters<typeof getOriginCandidates>
) =>
  queryOptions({
    queryKey: ["tunnels", "getOriginCandidates", args],
    queryFn: () => getOriginCandidates(...args),
    ...REMOTE_PROBE,
  });

export async function createCloudflareZone(
  data: Body<"create-cloudflare-zone">["data"]
) {
  return orFailure(
    () =>
      parseResponse(routes["create-cloudflare-zone"].$post({ json: { data } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function updateCloudflareZone(
  id: Body<"update-cloudflare-zone">["id"],
  data: Body<"update-cloudflare-zone">["data"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["update-cloudflare-zone"].$post({ json: { id, data } })
      ),
    (message) => ({ success: false, message }) as const
  );
}

export async function deleteCloudflareZone(
  id: Body<"delete-cloudflare-zone">["id"]
) {
  return orFailure(
    () =>
      parseResponse(routes["delete-cloudflare-zone"].$post({ json: { id } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function testCloudflareZone(
  input: Body<"test-cloudflare-zone">["input"]
) {
  return orFailure(
    () =>
      parseResponse(routes["test-cloudflare-zone"].$post({ json: { input } })),
    (message) => ({ ok: false, message }) as const
  );
}

export async function createTunnel(data: Body<"create-tunnel">["data"]) {
  return orFailure(
    () => parseResponse(routes["create-tunnel"].$post({ json: { data } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function updateTunnel(
  id: Body<"update-tunnel">["id"],
  data: Body<"update-tunnel">["data"]
) {
  return orFailure(
    () => parseResponse(routes["update-tunnel"].$post({ json: { id, data } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function deleteTunnel(id: Body<"delete-tunnel">["id"]) {
  return orFailure(
    () => parseResponse(routes["delete-tunnel"].$post({ json: { id } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function createTunnelRoute(
  input: Body<"create-tunnel-route">["input"]
) {
  return orFailure(
    () =>
      parseResponse(routes["create-tunnel-route"].$post({ json: { input } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function deleteTunnelRoute(
  input: Body<"delete-tunnel-route">["input"]
) {
  return orFailure(
    () =>
      parseResponse(routes["delete-tunnel-route"].$post({ json: { input } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function attachTunnelNetwork(
  input: Body<"attach-tunnel-network">["input"]
) {
  return orFailure(
    () =>
      parseResponse(routes["attach-tunnel-network"].$post({ json: { input } })),
    (message) => ({ success: false, message }) as const
  );
}
