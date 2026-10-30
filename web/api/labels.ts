import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, orFailure, type PostJson } from "@/web/api/client";

const routes = api.api.labels;
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

export async function listLabels() {
  return parseResponse(routes["list-labels"].$get());
}

export const listLabelsQuery = (...args: Parameters<typeof listLabels>) =>
  queryOptions({
    queryKey: ["labels", "listLabels", args],
    queryFn: () => listLabels(...args),
  });

export async function setIssueLabels(
  issueId: Body<"set-issue-labels">["issueId"],
  labelIds: Body<"set-issue-labels">["labelIds"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["set-issue-labels"].$post({ json: { issueId, labelIds } })
      ),
    () => ({ success: false }) as const
  );
}
