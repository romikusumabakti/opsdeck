import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { DocumentForm } from "@/components/document-form";
import { PageHeader } from "@/components/page-header";
import { getServerSession, isAdmin, requireSession } from "@/lib/auth-session";
import { loadCollections, loadDocumentBySlug } from "@/lib/knowledge";

export default async function EditDocumentPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  await requireSession();

  const [doc, collections, session, t] = await Promise.all([
    loadDocumentBySlug(slug),
    loadCollections(),
    getServerSession(),
    getTranslations("knowledge"),
  ]);
  if (!doc) notFound();
  const canDelete = session ? isAdmin(session) : false;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("editDocument")} subtitle={doc.title} />
      <DocumentForm
        mode={{ type: "edit", document: doc, canDelete }}
        collections={collections}
      />
    </div>
  );
}
