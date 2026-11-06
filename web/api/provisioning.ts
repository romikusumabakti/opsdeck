import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api } from "@/web/api/client";

const routes = api.api.environments[":id"].provisioning;

/** The environment's plan preview, stored steps and the active run, if any. */
export async function getProvisioning(environmentId: string) {
  return parseResponse(routes.$get({ param: { id: environmentId } }));
}

export const getProvisioningQuery = (environmentId: string) =>
  queryOptions({
    queryKey: ["provisioning", "getProvisioning", environmentId],
    queryFn: () => getProvisioning(environmentId),
  });

/** Starts (or resumes) a provisioning run. 409 when one is already running. */
export async function startProvisioning(environmentId: string) {
  return parseResponse(routes.$post({ param: { id: environmentId } }));
}

export type Provisioning = Awaited<ReturnType<typeof getProvisioning>>;
export type ProvisioningStep = Provisioning["steps"][number];
