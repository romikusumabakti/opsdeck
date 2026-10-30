import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, orFailure, type PostJson } from "@/web/api/client";

const routes = api.api.home;
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

export async function getAttentionGroups() {
  return parseResponse(routes["attention-groups"].$get());
}

export const getAttentionGroupsQuery = (
  ...args: Parameters<typeof getAttentionGroups>
) =>
  queryOptions({
    queryKey: ["home", "getAttentionGroups", args],
    queryFn: () => getAttentionGroups(...args),
  });

export async function listMyOpenIssues() {
  return parseResponse(routes["my-open-issues"].$get());
}

export const listMyOpenIssuesQuery = (
  ...args: Parameters<typeof listMyOpenIssues>
) =>
  queryOptions({
    queryKey: ["home", "listMyOpenIssues", args],
    queryFn: () => listMyOpenIssues(...args),
  });

export async function listRecentEnvironments() {
  return parseResponse(routes["recent-environments"].$get());
}

export const listRecentEnvironmentsQuery = (
  ...args: Parameters<typeof listRecentEnvironments>
) =>
  queryOptions({
    queryKey: ["home", "listRecentEnvironments", args],
    queryFn: () => listRecentEnvironments(...args),
  });

export async function listIssueProjects() {
  return parseResponse(routes["issue-projects"].$get());
}

export const listIssueProjectsQuery = (
  ...args: Parameters<typeof listIssueProjects>
) =>
  queryOptions({
    queryKey: ["home", "listIssueProjects", args],
    queryFn: () => listIssueProjects(...args),
  });

export async function getHomeAccess() {
  return parseResponse(routes.access.$get());
}

export const getHomeAccessQuery = (...args: Parameters<typeof getHomeAccess>) =>
  queryOptions({
    queryKey: ["home", "getHomeAccess", args],
    queryFn: () => getHomeAccess(...args),
  });

export async function acknowledgeAttentionGroup(
  environmentId: Body<"acknowledge-attention-group">["environmentId"],
  key: Body<"acknowledge-attention-group">["key"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["acknowledge-attention-group"].$post({
          json: { environmentId, key },
        })
      ),
    (message) => ({ success: false, message }) as const
  );
}

export async function unacknowledgeRuns(
  environmentId: Body<"unacknowledge-runs">["environmentId"],
  runIds: Body<"unacknowledge-runs">["runIds"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["unacknowledge-runs"].$post({ json: { environmentId, runIds } })
      ),
    (message) => ({ success: false, message }) as const
  );
}
