import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { canOrg } from "@/lib/permissions";
import { getAccessMatrixQuery } from "@/web/api/access";
import { meQuery, useMe } from "@/web/api/session";
import { listPendingInvitationsQuery, listUsersQuery } from "@/web/api/users";
import { requireOrgRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { UsersClient } from "./-components/admin/users/users-client";
import { UsersPending } from "./-components/admin/users-pending";

export const Route = createFileRoute("/$locale/_app/admin/users")({
  beforeLoad: ({ context: { queryClient } }) =>
    requireOrgRole(queryClient, { user: ["list"] }),
  // Each extra read needs its own permission; without it the tab is hidden and
  // the endpoint (which would refuse) is never called.
  loader: async ({ context: { queryClient } }) => {
    const me = await queryClient.query(meQuery());
    const role = me?.orgRole;
    await Promise.all([
      loaderQuery(queryClient, listUsersQuery()),
      canOrg(role, { user: ["invite"] })
        ? loaderQuery(queryClient, listPendingInvitationsQuery())
        : undefined,
      canOrg(role, { audit: ["read"] })
        ? loaderQuery(queryClient, getAccessMatrixQuery())
        : undefined,
    ]);
  },
  pendingComponent: UsersPending,
  component: UsersPage,
});

function UsersPage() {
  const me = useMe();
  const role = me?.orgRole;
  const canInvite = canOrg(role, { user: ["invite"] });
  const canViewAccess = canOrg(role, { audit: ["read"] });
  const { data: users, dataUpdatedAt } = useSuspenseQuery(listUsersQuery());
  const invitations = useQuery({
    ...listPendingInvitationsQuery(),
    enabled: canInvite,
  }).data;
  const matrix = useQuery({
    ...getAccessMatrixQuery(),
    enabled: canViewAccess,
  }).data;
  if (!me) return null;

  return (
    <UsersClient
      users={users}
      invitations={invitations ?? []}
      matrix={matrix ?? null}
      now={new Date(dataUpdatedAt).toISOString()}
      currentUserId={me.user.id}
      canInvite={canInvite}
      canRename={canOrg(role, { user: ["update"] })}
      canSetRole={canOrg(role, { user: ["set-role"] })}
      canOffboard={canOrg(role, { user: ["offboard"] })}
      canDelete={canOrg(role, { user: ["delete"] })}
    />
  );
}
