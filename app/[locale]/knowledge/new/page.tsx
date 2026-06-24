import { getTranslations, setRequestLocale } from "next-intl/server";
import { DocumentForm } from "@/components/document-form";
import { PageHeader } from "@/components/page-header";
import { redirect } from "@/i18n/navigation";
import { requireSession } from "@/lib/auth-session";
import { loadCollections, loadTreeNodes } from "@/lib/knowledge";

export default async function NewDocumentPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireSession();

  const [collections, nodes] = await Promise.all([
    loadCollections(),
    loadTreeNodes(),
  ]);
  // No collection to file under — bounce to the index, which prompts an admin
  // to create the first collection.
  if (collections.length === 0) await redirect("/knowledge");

  const t = await getTranslations("knowledge");
  const linkableDocs = nodes.map((n) => ({ title: n.title, slug: n.slug }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("newDocument")} subtitle={t("newDocumentHint")} />
      <DocumentForm
        mode={{ type: "create" }}
        collections={collections}
        linkableDocs={linkableDocs}
      />
    </div>
  );
}
