import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import type { IssueSort } from "@/lib/issue-query";
import { api, orFailure, type PostJson } from "@/web/api/client";

const routes = api.api.issues;
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

/** The global issues list's filters, sort and page (server: IssueQuery). */
export type IssueQuery = {
  /** Free text over the title and the human key (`CMEM-42`). */
  q?: string;
  status?: string;
  projectId?: string;
  labelId?: string;
  priority?: string;
  /** Restrict to one assignee — the "assigned to me" toggle. */
  assigneeId?: string;
  sort?: IssueSort;
  desc?: boolean;
  offset?: number;
  limit?: number;
};

export async function getOpenIssueCounts() {
  return parseResponse(routes["get-open-issue-counts"].$get());
}

export const getOpenIssueCountsQuery = (
  ...args: Parameters<typeof getOpenIssueCounts>
) =>
  queryOptions({
    queryKey: ["issues", "getOpenIssueCounts", args],
    queryFn: () => getOpenIssueCounts(...args),
  });

export async function getAssignedIssueCounts() {
  return parseResponse(routes["get-assigned-issue-counts"].$get());
}

export const getAssignedIssueCountsQuery = (
  ...args: Parameters<typeof getAssignedIssueCounts>
) =>
  queryOptions({
    queryKey: ["issues", "getAssignedIssueCounts", args],
    queryFn: () => getAssignedIssueCounts(...args),
  });

export async function getIssueDetail(projectKey: string, number: number) {
  return parseResponse(
    routes["get-issue-detail"].$get({
      query: { projectKey, number: String(number) },
    })
  );
}

export const getIssueDetailQuery = (
  ...args: Parameters<typeof getIssueDetail>
) =>
  queryOptions({
    queryKey: ["issues", "getIssueDetail", args],
    queryFn: () => getIssueDetail(...args),
  });

export async function listAllIssues(query: IssueQuery = {}) {
  return parseResponse(
    routes["list-all-issues"].$get({ query: { q: JSON.stringify(query) } })
  );
}

export const listAllIssuesQuery = (...args: Parameters<typeof listAllIssues>) =>
  queryOptions({
    queryKey: ["issues", "listAllIssues", args],
    queryFn: () => listAllIssues(...args),
  });

export async function listIssues(projectId: string) {
  return parseResponse(routes["list-issues"].$get({ query: { projectId } }));
}

export const listIssuesQuery = (...args: Parameters<typeof listIssues>) =>
  queryOptions({
    queryKey: ["issues", "listIssues", args],
    queryFn: () => listIssues(...args),
  });

export async function getIssueFormOptions(projectId: string) {
  return parseResponse(
    routes["get-issue-form-options"].$get({ query: { projectId } })
  );
}

export const getIssueFormOptionsQuery = (
  ...args: Parameters<typeof getIssueFormOptions>
) =>
  queryOptions({
    queryKey: ["issues", "getIssueFormOptions", args],
    queryFn: () => getIssueFormOptions(...args),
  });

export async function addComment(
  issueId: Body<"add-comment">["issueId"],
  body: Body<"add-comment">["body"]
) {
  return orFailure(
    () =>
      parseResponse(routes["add-comment"].$post({ json: { issueId, body } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function createIssue(data: Body<"create-issue">["data"]) {
  return orFailure(
    () => parseResponse(routes["create-issue"].$post({ json: { data } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function updateIssue(
  id: Body<"update-issue">["id"],
  data: Body<"update-issue">["data"]
) {
  return orFailure(
    () => parseResponse(routes["update-issue"].$post({ json: { id, data } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function setIssueStatus(
  id: Body<"set-issue-status">["id"],
  status: Body<"set-issue-status">["status"]
) {
  return orFailure(
    () =>
      parseResponse(routes["set-issue-status"].$post({ json: { id, status } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function bulkSetStatus(
  ids: Body<"bulk-set-status">["ids"],
  status: Body<"bulk-set-status">["status"]
) {
  return orFailure(
    () =>
      parseResponse(routes["bulk-set-status"].$post({ json: { ids, status } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function bulkDeleteIssues(ids: Body<"bulk-delete-issues">["ids"]) {
  return orFailure(
    () => parseResponse(routes["bulk-delete-issues"].$post({ json: { ids } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function deleteIssue(id: Body<"delete-issue">["id"]) {
  return orFailure(
    () => parseResponse(routes["delete-issue"].$post({ json: { id } })),
    (message) => ({ success: false, message }) as const
  );
}
