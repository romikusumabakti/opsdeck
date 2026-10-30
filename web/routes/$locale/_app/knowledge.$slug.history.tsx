import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useTranslations } from "use-intl";
import { KnowledgeBreadcrumb } from "@/components/knowledge-breadcrumb";
import { KnowledgeHistoryClient } from "@/components/knowledge-history-client";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { getDocumentQuery, listRevisionsQuery } from "@/web/api/knowledge";
import { orNotFound, requireOrgRole } from "@/web/project-guard";
import { KnowledgePending } from "./-components/knowledge/knowledge-pending";

export const Route = createFileRoute("/$locale/_app/knowledge/$slug/history")({
  beforeLoad: ({ context: { queryClient } }) =>
    requireOrgRole(queryClient, { knowledge: ["write"] }),
  loader: async ({ params: { slug }, context: { queryClient } }) => {
    await orNotFound(
      Promise.all([
        queryClient.query(getDocumentQuery(slug)),
        queryClient.query(listRevisionsQuery(slug)),
      ])
    );
  },
  pendingComponent: KnowledgePending,
  component: DocumentHistoryPage,
});

function DocumentHistoryPage() {
  const { slug } = Route.useParams();
  const t = useTranslations("knowledge");
  const doc = useSuspenseQuery(getDocumentQuery(slug)).data;
  const revisions = useSuspenseQuery(listRevisionsQuery(slug)).data;

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
          <Button
            nativeButton={false}
            render={<Link href={`/knowledge/${doc.slug}`} />}
            variant="outline"
            size="sm"
          >
            <ArrowLeft className="size-4" />
            {t("backToDocument")}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pt-6 pb-6 sm:px-6 lg:px-8">
        <PageHeader
          title={t("historyOf", { title: doc.title })}
          subtitle={t("historyHint")}
        />
        <KnowledgeHistoryClient documentId={doc.id} revisions={revisions} />
      </div>
    </div>
  );
}
