import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api } from "@/web/api/client";
import { REMOTE_PROBE } from "@/web/query-client";

const routes = api.api.environments[":id"].domain;

async function getEnvironmentDomain(environmentId: string) {
  return parseResponse(routes.$get({ param: { id: environmentId } }));
}

export const environmentDomainQuery = (environmentId: string) =>
  queryOptions({
    queryKey: ["environment-domain", environmentId],
    queryFn: () => getEnvironmentDomain(environmentId),
  });

// Calls the Cloudflare API on every fetch.
export const domainAccessPoliciesQuery = (environmentId: string) =>
  queryOptions({
    queryKey: ["environment-domain", environmentId, "accessPolicies"],
    queryFn: () =>
      parseResponse(
        routes["access-policies"].$get({ param: { id: environmentId } })
      ),
    ...REMOTE_PROBE,
  });

export async function putEnvironmentDomain(
  environmentId: string,
  body: Parameters<typeof routes.$put>[0]["json"]
) {
  return parseResponse(
    routes.$put({ param: { id: environmentId }, json: body })
  );
}

/**
 * Binds a hostname Cloudflare already routes through a registered tunnel
 * (org server:manage). Rejects with an ApiError whose `code` is a
 * DOMAIN_ERRORS key (or teardownRunning) when refused.
 */
export async function adoptEnvironmentDomain(
  environmentId: string,
  body: Parameters<(typeof routes.adopt)["$post"]>[0]["json"]
) {
  return parseResponse(
    routes.adopt.$post({ param: { id: environmentId }, json: body })
  );
}

export async function deleteEnvironmentDomain(environmentId: string) {
  return parseResponse(routes.$delete({ param: { id: environmentId } }));
}

export type EnvironmentDomain = Awaited<
  ReturnType<typeof getEnvironmentDomain>
>;
