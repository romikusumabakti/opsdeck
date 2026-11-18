import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { z } from "zod";
import { DocumentForm } from "@/components/document-form";
import { KnowledgeBreadcrumb } from "@/components/knowledge-breadcrumb";
import { redirect } from "@/i18n/navigation";
import type {
  KnowledgeCollectionView,
  KnowledgeTreeNode,
} from "@/lib/db/schema";
import type { Serialized } from "@/web/api/client";
import { listCollectionsQuery, listTreeNodesQuery } from "@/web/api/knowledge";
import { requireOrgRole } from "@/web/project-guard";
import { KnowledgePending } from "./-components/knowledge/knowledge-pending";

export const Route = createFileRoute("/$locale/_app/knowledge/new")({
  validateSearch: z.object({
    collection: z.uuid().optional().catch(undefined),
  }),
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
  const { collection } = Route.useSearch();
  const collections = useSuspenseQuery(listCollectionsQuery()).data;
  const nodes = useSuspenseQuery(listTreeNodesQuery()).data;
  return (
    <NewDocumentView
      collections={collections}
      nodes={nodes}
      requestedCollectionId={collection}
    />
  );
}

export function NewDocumentView({
  collections,
  nodes,
  requestedCollectionId,
}: {
  collections: Serialized<KnowledgeCollectionView>[];
  nodes: Serialized<KnowledgeTreeNode>[];
  requestedCollectionId?: string;
}) {
  const t = useTranslations("knowledge");
  const linkableDocs = nodes.map((n) => ({ title: n.title, slug: n.slug }));
  // Ignore an id that no longer names a collection.
  const target =
    collections.find((c) => c.id === requestedCollectionId) ?? collections[0];

  return (
    // Keyed so a changed ?collection= (same route, no remount) starts a fresh
    // form instead of keeping the previous collection in its state.
    <DocumentForm
      key={target?.id}
      mode={{ type: "create", defaultCollectionId: target?.id }}
      collections={collections}
      linkableDocs={linkableDocs}
      toolbarStart={
        <KnowledgeBreadcrumb
          items={[
            ...(target ? [{ label: target.name }] : []),
            { label: t("newDocument") },
          ]}
        />
      }
    />
  );
}
