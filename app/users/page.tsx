import { listPendingInvitations, listUsers } from "@/actions/users";
import { getServerSession } from "@/lib/auth-session";
import { redirect } from "next/navigation";
import { UsersClient } from "./users-client";

export default async function UsersPage() {
  const session = await getServerSession();
  if (!session) redirect("/sign-in?redirect=/users");

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
