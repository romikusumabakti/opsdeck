import { History, Link2, Pencil } from "lucide-react";
import { notFound } from "next/navigation";
import {
  getFormatter,
  getTranslations,
  setRequestLocale,
} from "next-intl/server";
import { MarkdownContent } from "@/components/markdown-content";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { requireSession } from "@/lib/auth-session";
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

  const [backlinks, t, tCommon, format] = await Promise.all([
    loadBacklinks(doc.id),
    getTranslations("knowledge"),
    getTranslations("common"),
    getFormatter(),
  ]);

  return (
    <article className="flex flex-col gap-6">
      <PageHeader
        title={doc.title}
        subtitle={t("inCollection", { collection: doc.collection.name })}
        action={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/knowledge/${doc.slug}/history`}>
                <History className="size-4" />
                {t("history")}
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link href={`/knowledge/${doc.slug}/edit`}>
                <Pencil className="size-4" />
                {tCommon("edit")}
              </Link>
            </Button>
          </div>
        }
      />

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
        <MarkdownContent content={doc.content} />
      ) : (
        <p className="text-sm text-muted-foreground italic">{t("emptyBody")}</p>
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
  );
}
