import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, orFailure, type PostJson } from "@/web/api/client";

const routes = api.api["issue-attachments"];
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

export async function listIssueAttachments(issueId: string) {
  return parseResponse(
    routes["list-issue-attachments"].$get({ query: { issueId } })
  );
}

export const listIssueAttachmentsQuery = (
  ...args: Parameters<typeof listIssueAttachments>
) =>
  queryOptions({
    queryKey: ["issue-attachments", "listIssueAttachments", args],
    queryFn: () => listIssueAttachments(...args),
  });

export async function deleteIssueAttachment(
  id: Body<"delete-issue-attachment">["id"]
) {
  return orFailure(
    () =>
      parseResponse(routes["delete-issue-attachment"].$post({ json: { id } })),
    (message) => ({ success: false, message }) as const
  );
}
export type IssueAttachmentRow = Awaited<
  ReturnType<typeof listIssueAttachments>
>[number];
