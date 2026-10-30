import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, orFailure, type PostJson } from "@/web/api/client";

const routes = api.api["project-members"];
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

export async function listProjectMembers(projectId: string) {
  return parseResponse(
    routes["list-project-members"].$get({ query: { projectId } })
  );
}

export const listProjectMembersQuery = (
  ...args: Parameters<typeof listProjectMembers>
) =>
  queryOptions({
    queryKey: ["project-members", "listProjectMembers", args],
    queryFn: () => listProjectMembers(...args),
  });

export async function listOrgWideAccess(projectId: string) {
  return parseResponse(
    routes["list-org-wide-access"].$get({ query: { projectId } })
  );
}

export const listOrgWideAccessQuery = (
  ...args: Parameters<typeof listOrgWideAccess>
) =>
  queryOptions({
    queryKey: ["project-members", "listOrgWideAccess", args],
    queryFn: () => listOrgWideAccess(...args),
  });

export async function listMemberCandidates(projectId: string) {
  return parseResponse(
    routes["list-member-candidates"].$get({ query: { projectId } })
  );
}

export const listMemberCandidatesQuery = (
  ...args: Parameters<typeof listMemberCandidates>
) =>
  queryOptions({
    queryKey: ["project-members", "listMemberCandidates", args],
    queryFn: () => listMemberCandidates(...args),
  });

export async function addProjectMember(
  input: Body<"add-project-member">["input"]
) {
  return orFailure(
    () =>
      parseResponse(routes["add-project-member"].$post({ json: { input } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function updateProjectMemberRole(
  input: Body<"update-project-member-role">["input"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["update-project-member-role"].$post({ json: { input } })
      ),
    (message) => ({ success: false, message }) as const
  );
}

export async function removeProjectMember(
  input: Body<"remove-project-member">["input"]
) {
  return orFailure(
    () =>
      parseResponse(routes["remove-project-member"].$post({ json: { input } })),
    (message) => ({ success: false, message }) as const
  );
}
export type ProjectMemberRow = Awaited<
  ReturnType<typeof listProjectMembers>
>[number];
export type OrgWideAccessRow = Awaited<
  ReturnType<typeof listOrgWideAccess>
>[number];
