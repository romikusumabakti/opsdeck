import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, NO_REFETCH } from "@/web/api/client";
import { REMOTE_PROBE } from "@/web/query-client";

const routes = api.api["cloudflare-account"];

export async function getCloudflareAccount() {
  return parseResponse(routes.$get());
}

export const getCloudflareAccountQuery = () =>
  queryOptions({
    queryKey: ["cloudflare-account", "getCloudflareAccount"],
    queryFn: getCloudflareAccount,
  });

export async function saveCloudflareAccount(
  input: Parameters<typeof routes.$put>[0]["json"]
) {
  return parseResponse(routes.$put({ json: input }));
}

export async function verifyCloudflareAccount() {
  return parseResponse(routes.verify.$post({}, NO_REFETCH));
}

// The three lists call the Cloudflare API on every fetch.
export const cloudflareTunnelsQuery = () =>
  queryOptions({
    queryKey: ["cloudflare-account", "tunnels"],
    queryFn: () => parseResponse(routes.tunnels.$get()),
    ...REMOTE_PROBE,
  });

export const cloudflareAccessPoliciesQuery = () =>
  queryOptions({
    queryKey: ["cloudflare-account", "accessPolicies"],
    queryFn: () => parseResponse(routes["access-policies"].$get()),
    ...REMOTE_PROBE,
  });

export const cloudflareIdentityProvidersQuery = () =>
  queryOptions({
    queryKey: ["cloudflare-account", "identityProviders"],
    queryFn: () => parseResponse(routes["identity-providers"].$get()),
    ...REMOTE_PROBE,
  });

export type CloudflareAccountRow = NonNullable<
  Awaited<ReturnType<typeof getCloudflareAccount>>
>;
