import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Link2 } from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";
import { DocumentActions } from "@/components/document-actions";
import { DocumentToc } from "@/components/document-toc";
import { KnowledgeBreadcrumb } from "@/components/knowledge-breadcrumb";
import { MarkdownContent } from "@/components/markdown-content";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { UserName } from "@/components/user/user-name";
import { Link } from "@/i18n/navigation";
import { DATE_TIME } from "@/lib/format-date";
import { canOrg } from "@/lib/permissions";
import { getBacklinksQuery, getDocumentQuery } from "@/web/api/knowledge";
import { useMe } from "@/web/api/session";
import { orNotFound } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";
import { KnowledgePending } from "./-components/knowledge/knowledge-pending";

export const Route = createFileRoute("/$locale/_app/knowledge/$slug/")({
  loader: async ({ params: { slug }, context: { queryClient } }) => {
    // A draft the caller may not see 404s like a missing document.
    const doc = await orNotFound(queryClient.query(getDocumentQuery(slug)));
    await loaderQuery(queryClient, getBacklinksQuery(doc.id));
  },
  pendingComponent: KnowledgePending,
  component: DocumentPage,
});

function DocumentPage() {
  const { slug } = Route.useParams();
  const t = useTranslations("knowledge");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const me = useMe();
  const doc = useSuspenseQuery(getDocumentQuery(slug)).data;
  const backlinks = useSuspenseQuery(getBacklinksQuery(doc.id)).data;
  const canDelete = canOrg(me?.orgRole, { knowledge: ["manage"] });

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Static toolbar — the article below is the scroll region, so the
          toolbar stays put without sticky positioning. */}
      <div className="flex shrink-0 items-center justify-between gap-4 bg-background px-4 pt-4 pb-3 sm:px-6 lg:px-8">
        <div className="min-w-0 flex-1">
          <KnowledgeBreadcrumb
            items={[{ label: doc.collection.name }, { label: doc.title }]}
          />
        </div>
        <div className="shrink-0">
          <DocumentActions
            documentId={doc.id}
            slug={doc.slug}
            canDelete={canDelete}
          />
        </div>
      </div>

      <div
        data-scroll-shadow
        className="flex min-h-0 flex-1 justify-center gap-10 overflow-y-auto px-4 sm:px-6 lg:px-8"
      >
        {/* Constrain the reading column to a comfortable measure (~70ch). */}
        <article className="flex w-full min-w-0 max-w-[46rem] flex-col">
          <div className="flex flex-col gap-4 pt-6 pb-6">
            <PageHeader
              title={doc.title}
              subtitle={t("inCollection", { collection: doc.collection.name })}
            />

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {doc.docType !== "doc" && (
                <Badge variant="outline">{t(`docType.${doc.docType}`)}</Badge>
              )}
              {doc.publishedAt === null && (
                <Badge variant="secondary">{t("draft")}</Badge>
              )}
              <span>
                {t.rich("updatedBy", {
                  name: doc.updatedBy?.name ?? tCommon("you"),
                  user: (chunks) =>
                    doc.updatedBy ? <UserName user={doc.updatedBy} /> : chunks,
                  time: format.dateTime(new Date(doc.updatedAt), DATE_TIME),
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
          </div>
        </article>

        <aside className="hidden w-56 shrink-0 pt-6 xl:block">
          <div className="sticky top-4 max-h-[calc(100svh-8rem)] overflow-y-auto">
            <DocumentToc containerId="doc-body" />
          </div>
        </aside>
      </div>
    </div>
  );
}
