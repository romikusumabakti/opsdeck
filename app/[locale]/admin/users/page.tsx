import { setRequestLocale } from "next-intl/server";
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

  const [users, invitations] = await Promise.all([
    listUsers(),
    // Invitations need user:invite; an observer (list only) sees none.
    canOrg(session.user.role, { user: ["invite"] })
      ? listPendingInvitations()
      : Promise.resolve([]),
  ]);

  return (
    <UsersClient
      users={users}
      invitations={invitations}
      currentUserId={session.user.id}
    />
  );
}
