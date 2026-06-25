import { Link2 } from "lucide-react";
import { notFound } from "next/navigation";
import {
  getFormatter,
  getTranslations,
  setRequestLocale,
} from "next-intl/server";
import { DocumentActions } from "@/components/document-actions";
import { DocumentToc } from "@/components/document-toc";
import { KnowledgeBreadcrumb } from "@/components/knowledge-breadcrumb";
import { MarkdownContent } from "@/components/markdown-content";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Link } from "@/i18n/navigation";
import { getServerSession, isAdmin, requireSession } from "@/lib/auth-session";
import { loadBacklinks, loadDocumentBySlug } from "@/lib/knowledge";

export default async function DocumentPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  await requireSession();

  const doc = await loadDocumentBySlug(slug);
  if (!doc) notFound();

  const [backlinks, session, t, tCommon, format] = await Promise.all([
    loadBacklinks(doc.id),
    getServerSession(),
    getTranslations("knowledge"),
    getTranslations("common"),
    getFormatter(),
  ]);
  const canDelete = session ? isAdmin(session) : false;

  return (
    <div className="flex justify-center gap-10">
      {/* Constrain the reading column to a comfortable measure (~70ch). */}
      <article className="flex w-full min-w-0 max-w-[46rem] flex-col gap-4">
        <div className="sticky top-14 z-10 flex flex-col gap-4 bg-background pb-3">
          <KnowledgeBreadcrumb
            items={[{ label: doc.collection.name }, { label: doc.title }]}
          />

          <PageHeader
            title={doc.title}
            subtitle={t("inCollection", { collection: doc.collection.name })}
            action={
              <DocumentActions
                documentId={doc.id}
                slug={doc.slug}
                canDelete={canDelete}
              />
            }
          />
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {doc.publishedAt === null && (
            <Badge variant="secondary">{t("draft")}</Badge>
          )}
          <span>
            {t("updatedBy", {
              name: doc.updatedBy?.name ?? tCommon("you"),
              time: format.dateTime(new Date(doc.updatedAt), {
                dateStyle: "medium",
                timeStyle: "short",
              }),
            })}
          </span>
        </div>

        {doc.content.trim() ? (
          <div id="doc-body">
            <MarkdownContent content={doc.content} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground italic">
            {t("emptyBody")}
          </p>
        )}

        {backlinks.length > 0 && (
          <section className="border-t pt-4">
            <h2 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
              <Link2 className="size-4" />
              {t("referencedBy")}
            </h2>
            <ul className="flex flex-col gap-1">
              {backlinks.map((b) => (
                <li key={b.id}>
                  <Link
                    href={`/knowledge/${b.slug}`}
                    className="text-sm text-primary underline underline-offset-2"
                  >
                    {b.title}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </article>

      <aside className="hidden w-56 shrink-0 xl:block">
        <div className="sticky top-16 max-h-[calc(100svh-5rem)] overflow-y-auto">
          <DocumentToc containerId="doc-body" />
        </div>
      </aside>
    </div>
  );
}
