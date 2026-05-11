import { getTranslations, setRequestLocale } from "next-intl/server";
import { listPendingInvitations, listUsers } from "@/actions/users";
import { PageHeader } from "@/components/page-header";
import { requireAdmin } from "@/lib/auth-session";
import { UsersClient } from "./users-client";

export default async function UsersPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const session = await requireAdmin();

  const [users, invitations] = await Promise.all([
    listUsers(),
    listPendingInvitations(),
  ]);

  const t = await getTranslations("users");

  return (
    <div className="max-w-4xl py-8 mx-auto w-full px-4 flex flex-col gap-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <UsersClient
        users={users}
        invitations={invitations}
        currentUserId={session.user.id}
      />
    </div>
  );
}
