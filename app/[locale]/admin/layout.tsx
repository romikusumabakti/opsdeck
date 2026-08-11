import { setRequestLocale } from "next-intl/server";
import { requireAdmin } from "@/lib/auth-session";

// One gate for the whole admin area. Every page below can assume an admin
// session, so they don't repeat the check (non-admins are redirected home by
// `requireCapability` before any child renders).
export default async function AdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin();
  return children;
}
