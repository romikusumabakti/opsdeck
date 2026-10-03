import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { DocumentForm } from "@/components/document-form";
import { KnowledgeBreadcrumb } from "@/components/knowledge-breadcrumb";
import { requireOrgPage } from "@/lib/authz";
import {
  loadCollections,
  loadDocumentBySlug,
  loadTreeNodes,
} from "@/lib/knowledge";
import { canOrg } from "@/lib/permissions";

export default async function EditDocumentPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const session = await requireOrgPage({ knowledge: ["write"] });

  const [doc, collections, nodes, t] = await Promise.all([
    loadDocumentBySlug(slug),
    loadCollections(),
    loadTreeNodes(),
    getTranslations("knowledge"),
  ]);
  if (!doc) notFound();
  const canDelete = canOrg(session.user.role, { knowledge: ["manage"] });
  // Linkable targets exclude the document itself — no self-links.
  const linkableDocs = nodes
    .filter((n) => n.id !== doc.id)
    .map((n) => ({ title: n.title, slug: n.slug }));

  return (
    <DocumentForm
      mode={{ type: "edit", document: doc, canDelete }}
      collections={collections}
      linkableDocs={linkableDocs}
      toolbarStart={
        <KnowledgeBreadcrumb
          items={[
            { label: doc.title, href: `/knowledge/${doc.slug}` },
            { label: t("editDocument") },
          ]}
        />
      }
    />
  );
}
