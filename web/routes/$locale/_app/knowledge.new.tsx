import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { DocumentForm } from "@/components/document-form";
import { KnowledgeBreadcrumb } from "@/components/knowledge-breadcrumb";
import { redirect } from "@/i18n/navigation";
import { listCollectionsQuery, listTreeNodesQuery } from "@/web/api/knowledge";
import { requireOrgRole } from "@/web/project-guard";
import { KnowledgePending } from "./-components/knowledge/knowledge-pending";

export const Route = createFileRoute("/$locale/_app/knowledge/new")({
  beforeLoad: ({ context: { queryClient } }) =>
    requireOrgRole(queryClient, { knowledge: ["write"] }),
  loader: async ({ params: { locale }, context: { queryClient } }) => {
    const [collections] = await Promise.all([
      queryClient.query(listCollectionsQuery()),
      queryClient.query(listTreeNodesQuery()),
    ]);
    // No collection to file under — bounce to the index, which prompts an
    // admin to create the first collection.
    if (collections.length === 0) redirect("/knowledge", locale);
  },
  pendingComponent: KnowledgePending,
  component: NewDocumentPage,
});

function NewDocumentPage() {
  const t = useTranslations("knowledge");
  const collections = useSuspenseQuery(listCollectionsQuery()).data;
  const nodes = useSuspenseQuery(listTreeNodesQuery()).data;
  const linkableDocs = nodes.map((n) => ({ title: n.title, slug: n.slug }));

  return (
    <DocumentForm
      mode={{ type: "create" }}
      collections={collections}
      linkableDocs={linkableDocs}
      toolbarStart={
        <KnowledgeBreadcrumb items={[{ label: t("newDocument") }]} />
      }
    />
  );
}
