import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, type PostJson } from "@/web/api/client";

// Project groups. The writes return plain data, so a refusal rejects with the
// ApiError and its `code` (groupNameTaken 409, groupNotFound 404,
// groupMergeSelf / groupReorderInvalid 400, 403 for a non-admin).
const routes = api.api["project-groups"];
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

export async function listGroups() {
  return parseResponse(routes["list-groups"].$get());
}

export const listGroupsQuery = (...args: Parameters<typeof listGroups>) =>
  queryOptions({
    queryKey: ["project-groups", "listGroups", args],
    queryFn: () => listGroups(...args),
  });

export type ProjectGroupSummary = Awaited<
  ReturnType<typeof listGroups>
>[number];

export async function createGroup(name: Body<"create-group">["name"]) {
  return parseResponse(routes["create-group"].$post({ json: { name } }));
}

export async function renameGroup(
  id: Body<"rename-group">["id"],
  name: Body<"rename-group">["name"]
) {
  return parseResponse(routes["rename-group"].$post({ json: { id, name } }));
}

/** Place the group after `after` and/or before `before` (its new neighbours). */
export async function reorderGroup(
  id: Body<"reorder-group">["id"],
  position: Omit<Body<"reorder-group">, "id">
) {
  return parseResponse(
    routes["reorder-group"].$post({ json: { id, ...position } })
  );
}

/** Move every project of `from` into `into`, then delete `from`. */
export async function mergeGroups(
  from: Body<"merge-groups">["from"],
  into: Body<"merge-groups">["into"]
) {
  return parseResponse(routes["merge-groups"].$post({ json: { from, into } }));
}

/** Delete a group; its projects become ungrouped. */
export async function deleteGroup(id: Body<"delete-group">["id"]) {
  return parseResponse(routes["delete-group"].$post({ json: { id } }));
}
