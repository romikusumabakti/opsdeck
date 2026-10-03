import { setRequestLocale } from "next-intl/server";
import { requireOrgPage } from "@/lib/authz";

// Baseline gate for the admin area: audit:read. It is not sufficient on its
// own (layouts don't re-run on client navigation), so every child page also
// calls requireOrgPage with the permission it actually needs.
export default async function AdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireOrgPage({ audit: ["read"] });
  return children;
}
