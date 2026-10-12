import { setRequestLocale } from "next-intl/server";
import { getAccessMatrix } from "@/actions/access";
import { listPendingInvitations, listUsers } from "@/actions/users";
import { requireOrgPage } from "@/lib/authz";
import { canOrg } from "@/lib/permissions";
import { UsersClient } from "./users-client";

export default async function UsersPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const session = await requireOrgPage({ user: ["list"] });

  const role = session.user.role;
  const canInvite = canOrg(role, { user: ["invite"] });
  const canViewAccess = canOrg(role, { audit: ["read"] });

  // Each extra read needs its own permission; without it the tab is hidden and
  // the action (which would throw) is never called.
  const [users, invitations, matrix] = await Promise.all([
    listUsers(),
    canInvite ? listPendingInvitations() : Promise.resolve([]),
    canViewAccess ? getAccessMatrix() : Promise.resolve(null),
  ]);

  return (
    <UsersClient
      users={users}
      invitations={invitations}
      matrix={matrix}
      now={new Date().toISOString()}
      currentUserId={session.user.id}
      canInvite={canInvite}
      canRename={canOrg(role, { user: ["update"] })}
      canSetRole={canOrg(role, { user: ["set-role"] })}
      canOffboard={canOrg(role, { user: ["offboard"] })}
      canDelete={canOrg(role, { user: ["delete"] })}
    />
  );
}
