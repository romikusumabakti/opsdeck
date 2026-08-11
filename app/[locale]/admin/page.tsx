import { setRequestLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";

// The admin area has no dashboard of its own — it's a container for the
// sections listed in the sidebar. Land on Activity, the read-only one.
export default async function AdminPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  await redirect("/admin/activity");
}
