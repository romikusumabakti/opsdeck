import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, orFailure, type PostJson } from "@/web/api/client";

const routes = api.api["test-runs"];
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

export async function listIssueTestRuns(issueId: string) {
  return parseResponse(
    routes["list-issue-test-runs"].$get({ query: { issueId } })
  );
}

export const listIssueTestRunsQuery = (
  ...args: Parameters<typeof listIssueTestRuns>
) =>
  queryOptions({
    queryKey: ["test-runs", "listIssueTestRuns", args],
    queryFn: () => listIssueTestRuns(...args),
  });

export async function recordTestRun(data: Body<"record-test-run">["data"]) {
  return orFailure(
    () => parseResponse(routes["record-test-run"].$post({ json: { data } })),
    (message) => ({ success: false, message }) as const
  );
}
export type TestRunRow = Awaited<ReturnType<typeof listIssueTestRuns>>[number];
