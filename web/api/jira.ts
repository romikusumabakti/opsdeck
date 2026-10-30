import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, orFailure, type PostJson } from "@/web/api/client";

const routes = api.api.integrations.jira;
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

export async function getJiraConnections() {
  return parseResponse(routes["get-jira-connections"].$get());
}

export const getJiraConnectionsQuery = (
  ...args: Parameters<typeof getJiraConnections>
) =>
  queryOptions({
    queryKey: ["jira", "getJiraConnections", args],
    queryFn: () => getJiraConnections(...args),
  });

export async function getJiraConnection(id: string) {
  return parseResponse(routes["get-jira-connection"].$get({ query: { id } }));
}

export const getJiraConnectionQuery = (
  ...args: Parameters<typeof getJiraConnection>
) =>
  queryOptions({
    queryKey: ["jira", "getJiraConnection", args],
    queryFn: () => getJiraConnection(...args),
  });

export async function getJiraWebhookUrl(connectionId: string) {
  return parseResponse(
    routes["get-jira-webhook-url"].$get({ query: { connectionId } })
  );
}

export const getJiraWebhookUrlQuery = (
  ...args: Parameters<typeof getJiraWebhookUrl>
) =>
  queryOptions({
    queryKey: ["jira", "getJiraWebhookUrl", args],
    queryFn: () => getJiraWebhookUrl(...args),
  });

export async function getJiraLink(projectId: string) {
  return parseResponse(routes["get-jira-link"].$get({ query: { projectId } }));
}

export const getJiraLinkQuery = (...args: Parameters<typeof getJiraLink>) =>
  queryOptions({
    queryKey: ["jira", "getJiraLink", args],
    queryFn: () => getJiraLink(...args),
  });

export async function createJiraConnection(
  data: Body<"create-jira-connection">["data"]
) {
  return orFailure(
    () =>
      parseResponse(routes["create-jira-connection"].$post({ json: { data } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function updateJiraConnection(
  id: Body<"update-jira-connection">["id"],
  data: Body<"update-jira-connection">["data"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["update-jira-connection"].$post({ json: { id, data } })
      ),
    (message) => ({ success: false, message }) as const
  );
}

export async function deleteJiraConnection(
  id: Body<"delete-jira-connection">["id"]
) {
  return orFailure(
    () =>
      parseResponse(routes["delete-jira-connection"].$post({ json: { id } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function testJiraConnection(
  input: Body<"test-jira-connection">["input"]
) {
  return orFailure(
    () =>
      parseResponse(routes["test-jira-connection"].$post({ json: { input } })),
    (message) => ({ ok: false, message }) as const
  );
}

export async function saveJiraLink(data: Body<"save-jira-link">["data"]) {
  return orFailure(
    () => parseResponse(routes["save-jira-link"].$post({ json: { data } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function unlinkJiraProject(
  projectId: Body<"unlink-jira-project">["projectId"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["unlink-jira-project"].$post({ json: { projectId } })
      ),
    (message) => ({ success: false, message }) as const
  );
}

export async function syncJiraProjectNow(
  projectId: Body<"sync-jira-project-now">["projectId"],
  full?: Body<"sync-jira-project-now">["full"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["sync-jira-project-now"].$post({ json: { projectId, full } })
      ),
    (message) => ({ success: false, message }) as const
  );
}

export type JiraConnectionRow = Awaited<
  ReturnType<typeof getJiraConnections>
>[number];
