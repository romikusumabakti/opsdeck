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
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <UsersClient
        users={users}
        invitations={invitations}
        currentUserId={session.user.id}
      />
    </>
  );
}
