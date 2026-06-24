import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { KnowledgeHistoryClient } from "@/components/knowledge-history-client";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { requireSession } from "@/lib/auth-session";
import { loadDocumentBySlug, loadRevisions } from "@/lib/knowledge";

export default async function DocumentHistoryPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  await requireSession();

  const doc = await loadDocumentBySlug(slug);
  if (!doc) notFound();

  const [revisions, t] = await Promise.all([
    loadRevisions(doc.id),
    getTranslations("knowledge"),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("historyOf", { title: doc.title })}
        subtitle={t("historyHint")}
        action={
          <Button asChild variant="outline" size="sm">
            <Link href={`/knowledge/${doc.slug}`}>
              <ArrowLeft className="size-4" />
              {t("backToDocument")}
            </Link>
          </Button>
        }
      />
      <KnowledgeHistoryClient
        documentId={doc.id}
        documentSlug={doc.slug}
        revisions={revisions}
      />
    </div>
  );
}
