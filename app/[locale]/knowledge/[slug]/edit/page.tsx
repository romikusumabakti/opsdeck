import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { DocumentForm } from "@/components/document-form";
import { KnowledgeBreadcrumb } from "@/components/knowledge-breadcrumb";
import { PageHeader } from "@/components/page-header";
import { getServerSession, isAdmin, requireSession } from "@/lib/auth-session";
import {
  loadCollections,
  loadDocumentBySlug,
  loadTreeNodes,
} from "@/lib/knowledge";

export default async function EditDocumentPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  await requireSession();

  const [doc, collections, nodes, session, t] = await Promise.all([
    loadDocumentBySlug(slug),
    loadCollections(),
    loadTreeNodes(),
    getServerSession(),
    getTranslations("knowledge"),
  ]);
  if (!doc) notFound();
  const canDelete = session ? isAdmin(session) : false;
  // Linkable targets exclude the document itself — no self-links.
  const linkableDocs = nodes
    .filter((n) => n.id !== doc.id)
    .map((n) => ({ title: n.title, slug: n.slug }));

  return (
    <div className="flex flex-col gap-6">
      <KnowledgeBreadcrumb
        items={[
          { label: doc.title, href: `/knowledge/${doc.slug}` },
          { label: t("editDocument") },
        ]}
      />
      <PageHeader title={t("editDocument")} subtitle={doc.title} />
      <DocumentForm
        mode={{ type: "edit", document: doc, canDelete }}
        collections={collections}
        linkableDocs={linkableDocs}
      />
    </div>
  );
}
