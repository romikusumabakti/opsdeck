import { setRequestLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";
import { requireOrgPage } from "@/lib/authz";
import { canOrg } from "@/lib/permissions";

// The admin area has no dashboard of its own — it's a container for the
// sections listed in the sidebar. Land on Users (people and their project
// access) when the role may list users, else on Activity, which every role
// that reaches the admin area (audit:read) can open.
export default async function AdminPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await requireOrgPage({ audit: ["read"] });
  await redirect(
    canOrg(session.user.role, { user: ["list"] })
      ? "/admin/users"
      : "/admin/activity"
  );
}
