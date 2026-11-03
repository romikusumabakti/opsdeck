import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, type PostJson } from "@/web/api/client";

const routes = api.api.deploys;
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

export async function listDeployTargets(environmentId: string) {
  return parseResponse(routes.targets.$get({ query: { environmentId } }));
}

export const listDeployTargetsQuery = (
  ...args: Parameters<typeof listDeployTargets>
) =>
  queryOptions({
    queryKey: ["deploys", "listDeployTargets", args],
    queryFn: () => listDeployTargets(...args),
  });

export async function createDeployTarget(input: Body<"targets">) {
  return parseResponse(routes.targets.$post({ json: input }));
}

export async function updateDeployTarget(
  id: string,
  changes: Parameters<(typeof routes.targets)[":id"]["$patch"]>[0]["json"]
) {
  return parseResponse(
    routes.targets[":id"].$patch({ param: { id }, json: changes })
  );
}

export async function deleteDeployTarget(id: string) {
  return parseResponse(routes.targets[":id"].$delete({ param: { id } }));
}

export async function deployTag(
  targetId: Body<"deploy">["targetId"],
  tag: Body<"deploy">["tag"]
) {
  return parseResponse(routes.deploy.$post({ json: { targetId, tag } }));
}

export async function rollbackTarget(targetId: Body<"rollback">["targetId"]) {
  return parseResponse(routes.rollback.$post({ json: { targetId } }));
}

export type DeployTargetState = Awaited<
  ReturnType<typeof listDeployTargets>
>[number];
