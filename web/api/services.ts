import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, type PostJson } from "@/web/api/client";
import { REMOTE_PROBE } from "@/web/query-client";

const routes = api.api.services;
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

export async function getAllServiceStatuses(environmentId: string) {
  return parseResponse(
    routes["get-all-service-statuses"].$get({ query: { environmentId } })
  );
}

export const getAllServiceStatusesQuery = (
  ...args: Parameters<typeof getAllServiceStatuses>
) =>
  queryOptions({
    queryKey: ["services", "getAllServiceStatuses", args],
    queryFn: () => getAllServiceStatuses(...args),
    ...REMOTE_PROBE,
  });

export async function controlService(
  environmentId: Body<"control-service">["environmentId"],
  role: Body<"control-service">["role"],
  action: Body<"control-service">["action"]
) {
  return parseResponse(
    routes["control-service"].$post({ json: { environmentId, role, action } })
  );
}

export type ServiceStatusResult = Awaited<
  ReturnType<typeof getAllServiceStatuses>
>[number];
