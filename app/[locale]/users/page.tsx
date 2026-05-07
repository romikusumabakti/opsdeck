import { listPendingInvitations, listUsers } from "@/actions/users";
import { redirect } from "@/i18n/navigation";
import { getServerSession } from "@/lib/auth-session";
import { UsersClient } from "./users-client";

export default async function UsersPage() {
  const session = await getServerSession();
  if (!session) await redirect("/sign-in?redirect=/users");

  const [users, invitations] = await Promise.all([
    listUsers(),
    listPendingInvitations(),
  ]);

  return (
    <div className="max-w-4xl py-8">
      <UsersClient
        users={users}
        invitations={invitations}
        currentUserId={session.user.id}
      />
    </div>
  );
}
