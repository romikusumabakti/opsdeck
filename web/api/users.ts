import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, orFailure, type PostJson } from "@/web/api/client";

const onboarding = api.api.onboarding;
const routes = api.api.users;
type Body<K extends keyof typeof routes | keyof typeof onboarding> = PostJson<
  typeof routes & typeof onboarding,
  K
>;

export async function hasAnyUser() {
  return parseResponse(onboarding["has-any-user"].$get());
}

export const hasAnyUserQuery = (...args: Parameters<typeof hasAnyUser>) =>
  queryOptions({
    queryKey: ["users", "hasAnyUser", args],
    queryFn: () => hasAnyUser(...args),
  });

export async function createInitialUser(
  input: Body<"create-initial-user">["input"]
) {
  return orFailure(
    () =>
      parseResponse(
        onboarding["create-initial-user"].$post({ json: { input } })
      ),
    (message) => ({ success: false, message }) as const
  );
}

export async function getInvitationByToken(token: string) {
  return parseResponse(
    onboarding["get-invitation-by-token"].$get({ query: { token } })
  );
}

export const getInvitationByTokenQuery = (
  ...args: Parameters<typeof getInvitationByToken>
) =>
  queryOptions({
    queryKey: ["users", "getInvitationByToken", args],
    queryFn: () => getInvitationByToken(...args),
  });

export async function acceptInvitation(
  input: Body<"accept-invitation">["input"]
) {
  return orFailure(
    () =>
      parseResponse(onboarding["accept-invitation"].$post({ json: { input } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function listAssignableUsers(projectId: string) {
  return parseResponse(
    routes["list-assignable-users"].$get({ query: { projectId } })
  );
}

export const listAssignableUsersQuery = (
  ...args: Parameters<typeof listAssignableUsers>
) =>
  queryOptions({
    queryKey: ["users", "listAssignableUsers", args],
    queryFn: () => listAssignableUsers(...args),
  });

export async function listAssignableUsersAcrossProjects() {
  return parseResponse(routes["list-assignable-users-across-projects"].$get());
}

export const listAssignableUsersAcrossProjectsQuery = (
  ...args: Parameters<typeof listAssignableUsersAcrossProjects>
) =>
  queryOptions({
    queryKey: ["users", "listAssignableUsersAcrossProjects", args],
    queryFn: () => listAssignableUsersAcrossProjects(...args),
  });

export async function listUsers() {
  return parseResponse(routes["list-users"].$get());
}

export const listUsersQuery = (...args: Parameters<typeof listUsers>) =>
  queryOptions({
    queryKey: ["users", "listUsers", args],
    queryFn: () => listUsers(...args),
  });

export async function listPendingInvitations() {
  return parseResponse(routes["list-pending-invitations"].$get());
}

export const listPendingInvitationsQuery = (
  ...args: Parameters<typeof listPendingInvitations>
) =>
  queryOptions({
    queryKey: ["users", "listPendingInvitations", args],
    queryFn: () => listPendingInvitations(...args),
  });

export async function inviteUser(input: Body<"invite-user">["input"]) {
  return orFailure(
    () => parseResponse(routes["invite-user"].$post({ json: { input } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function updateUserRole(input: Body<"update-user-role">["input"]) {
  return orFailure(
    () => parseResponse(routes["update-user-role"].$post({ json: { input } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function deleteUser(userId: Body<"delete-user">["userId"]) {
  return orFailure(
    () => parseResponse(routes["delete-user"].$post({ json: { userId } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function revokeInvitation(
  invitationId: Body<"revoke-invitation">["invitationId"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["revoke-invitation"].$post({ json: { invitationId } })
      ),
    (message) => ({ success: false, message }) as const
  );
}

export async function resendInvitation(
  invitationId: Body<"resend-invitation">["invitationId"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["resend-invitation"].$post({ json: { invitationId } })
      ),
    (message) => ({ success: false, message }) as const
  );
}

export async function bulkDeleteUsers(ids: Body<"bulk-delete-users">["ids"]) {
  return orFailure(
    () => parseResponse(routes["bulk-delete-users"].$post({ json: { ids } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function bulkRevokeInvitations(
  ids: Body<"bulk-revoke-invitations">["ids"]
) {
  return orFailure(
    () =>
      parseResponse(routes["bulk-revoke-invitations"].$post({ json: { ids } })),
    (message) => ({ success: false, message }) as const
  );
}

// Page data (server/routes/users.ts).

/** The people directory, as the caller's role may see it. */
export async function listPeople() {
  return parseResponse(routes.people.$get());
}

export const listPeopleQuery = (...args: Parameters<typeof listPeople>) =>
  queryOptions({
    queryKey: ["users", "listPeople", args],
    queryFn: () => listPeople(...args),
  });

/**
 * A person's page: `{ card, projects, openIssues, runs, meta }`. Rejects with
 * a 404 ApiError for an unknown or hidden user.
 */
export async function getPerson(id: string) {
  return parseResponse(routes[":id"].person.$get({ param: { id } }));
}

export const getPersonQuery = (...args: Parameters<typeof getPerson>) =>
  queryOptions({
    queryKey: ["users", "getPerson", args],
    queryFn: () => getPerson(...args),
  });

/** The hover card for a user. */
export async function getUserCard(id: string) {
  return parseResponse(routes[":id"].card.$get({ param: { id } }));
}

export const getUserCardQuery = (...args: Parameters<typeof getUserCard>) =>
  queryOptions({
    queryKey: ["users", "getUserCard", args],
    queryFn: () => getUserCard(...args),
  });

export type PersonSummary = Awaited<ReturnType<typeof listPeople>>[number];
