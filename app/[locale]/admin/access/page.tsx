import { setRequestLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";

// Access was merged into the users page as its "Project access" tab. Keep old
// bookmarks working; the users page enforces its own guard.
export default async function AccessPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  await redirect("/admin/users?tab=access");
}
