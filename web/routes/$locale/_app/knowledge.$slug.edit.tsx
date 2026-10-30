import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { DocumentForm } from "@/components/document-form";
import { KnowledgeBreadcrumb } from "@/components/knowledge-breadcrumb";
import { canOrg } from "@/lib/permissions";
import {
  getDocumentQuery,
  listCollectionsQuery,
  listTreeNodesQuery,
} from "@/web/api/knowledge";
import { useMe } from "@/web/api/session";
import { orNotFound, requireOrgRole } from "@/web/project-guard";
import { KnowledgePending } from "./-components/knowledge/knowledge-pending";

export const Route = createFileRoute("/$locale/_app/knowledge/$slug/edit")({
  beforeLoad: ({ context: { queryClient } }) =>
    requireOrgRole(queryClient, { knowledge: ["write"] }),
  loader: async ({ params: { slug }, context: { queryClient } }) => {
    await orNotFound(
      Promise.all([
        queryClient.query(getDocumentQuery(slug)),
        queryClient.query(listCollectionsQuery()),
        queryClient.query(listTreeNodesQuery()),
      ])
    );
  },
  pendingComponent: KnowledgePending,
  component: EditDocumentPage,
});

function EditDocumentPage() {
  const { slug } = Route.useParams();
  const t = useTranslations("knowledge");
  const me = useMe();
  const doc = useSuspenseQuery(getDocumentQuery(slug)).data;
  const collections = useSuspenseQuery(listCollectionsQuery()).data;
  const nodes = useSuspenseQuery(listTreeNodesQuery()).data;
  const canDelete = canOrg(me?.orgRole, { knowledge: ["manage"] });
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
