import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { KnowledgeBreadcrumb } from "@/components/knowledge-breadcrumb";
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
    <div className="flex h-full min-h-0 flex-col">
      {/* Static toolbar — the content below is the scroll region, so the
          toolbar stays put without sticky positioning. */}
      <div className="flex shrink-0 items-center justify-between gap-4 bg-background px-4 pt-4 pb-3 sm:px-6 lg:px-8">
        <div className="min-w-0 flex-1">
          <KnowledgeBreadcrumb
            items={[
              { label: doc.title, href: `/knowledge/${doc.slug}` },
              { label: t("history") },
            ]}
          />
        </div>
        <div className="shrink-0">
          <Button asChild variant="outline" size="sm">
            <Link href={`/knowledge/${doc.slug}`}>
              <ArrowLeft className="size-4" />
              {t("backToDocument")}
            </Link>
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pt-6 pb-6 sm:px-6 lg:px-8">
        <PageHeader
          title={t("historyOf", { title: doc.title })}
          subtitle={t("historyHint")}
        />
        <KnowledgeHistoryClient
          documentId={doc.id}
          documentSlug={doc.slug}
          revisions={revisions}
        />
      </div>
    </div>
  );
}
