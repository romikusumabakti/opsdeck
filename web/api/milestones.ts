import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, orFailure, type PostJson } from "@/web/api/client";

const routes = api.api.milestones;
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

export async function listMilestones(projectId: string) {
  return parseResponse(
    routes["list-milestones"].$get({ query: { projectId } })
  );
}

export const listMilestonesQuery = (
  ...args: Parameters<typeof listMilestones>
) =>
  queryOptions({
    queryKey: ["milestones", "listMilestones", args],
    queryFn: () => listMilestones(...args),
  });

export async function createMilestone(data: Body<"create-milestone">["data"]) {
  return orFailure(
    () => parseResponse(routes["create-milestone"].$post({ json: { data } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function updateMilestone(
  id: Body<"update-milestone">["id"],
  data: Body<"update-milestone">["data"]
) {
  return orFailure(
    () =>
      parseResponse(routes["update-milestone"].$post({ json: { id, data } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function setMilestoneClosed(
  id: Body<"set-milestone-closed">["id"],
  closed: Body<"set-milestone-closed">["closed"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["set-milestone-closed"].$post({ json: { id, closed } })
      ),
    (message) => ({ success: false, message }) as const
  );
}

export async function deleteMilestone(id: Body<"delete-milestone">["id"]) {
  return orFailure(
    () => parseResponse(routes["delete-milestone"].$post({ json: { id } })),
    (message) => ({ success: false, message }) as const
  );
}
export type MilestoneWithCount = Awaited<
  ReturnType<typeof listMilestones>
>[number];
