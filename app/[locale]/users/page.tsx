import { getTranslations, setRequestLocale } from "next-intl/server";
import { listPendingInvitations, listUsers } from "@/actions/users";
import { redirect } from "@/i18n/navigation";
import { getServerSession } from "@/lib/auth-session";
import { UsersClient } from "./users-client";

export default async function UsersPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const session = await getServerSession();
  if (!session) await redirect("/sign-in?redirect=/users");

  const [users, invitations] = await Promise.all([
    listUsers(),
    listPendingInvitations(),
  ]);

  const t = await getTranslations("users");

  return (
    <div className="max-w-4xl py-8 mx-auto w-full px-4">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t("subtitle")}</p>
      </div>
      <UsersClient
        users={users}
        invitations={invitations}
        currentUserId={session.user.id}
      />
    </div>
  );
}
