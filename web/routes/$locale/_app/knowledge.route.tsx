import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { BookOpen, Plus } from "lucide-react";
import { useTranslations } from "use-intl";
import { CollectionCreateDialog } from "@/components/collection-create-dialog";
import { KnowledgeSearch } from "@/components/knowledge-search";
import { KnowledgeTree } from "@/components/knowledge-tree";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { canOrg } from "@/lib/permissions";
import { listCollectionsQuery, listTreeNodesQuery } from "@/web/api/knowledge";
import { useMe } from "@/web/api/session";
import { requireOrgRole } from "@/web/project-guard";
import { loaderQuery } from "@/web/query-client";

// The knowledge area (the port of `knowledge/layout.tsx`): a tree sidebar and
// the document pages in `<Outlet />`. Each child brings its own pending
// skeleton, so the sidebar stays put while a document loads.
export const Route = createFileRoute("/$locale/_app/knowledge")({
  beforeLoad: ({ context: { queryClient } }) =>
    requireOrgRole(queryClient, { knowledge: ["read"] }),
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      loaderQuery(queryClient, listCollectionsQuery()),
      loaderQuery(queryClient, listTreeNodesQuery()),
    ]);
  },
  component: KnowledgeLayout,
});

function KnowledgeLayout() {
  const t = useTranslations("knowledge");
  const me = useMe();
  const canManage = canOrg(me?.orgRole, { knowledge: ["manage"] });
  const collections = useSuspenseQuery(listCollectionsQuery()).data;
  const nodes = useSuspenseQuery(listTreeNodesQuery()).data;

  return (
    <div className="-mx-4 -my-6 flex h-[calc(100svh-3.5rem)] flex-col overflow-hidden sm:-mx-6 lg:-mx-8 lg:flex-row">
      <aside className="flex shrink-0 flex-col border-b lg:h-full lg:w-64 lg:shrink-0 lg:border-b-0 lg:border-e">
        <div className="flex flex-col gap-3 px-3 py-4 lg:shrink-0">
          <div className="flex items-center justify-between gap-2 px-2">
            <Link
              href="/knowledge"
              className="flex items-center gap-1.5 text-sm font-semibold"
            >
              <BookOpen className="size-4" />
              {t("title")}
            </Link>
            {canManage && <CollectionCreateDialog />}
          </div>
          {collections.length > 0 && (
            <>
              <KnowledgeSearch />
              <Button
                nativeButton={false}
                render={<Link href="/knowledge/new" />}
                size="sm"
                variant="outline"
                className="mx-2"
              >
                <Plus className="size-4" />
                {t("newDocument")}
              </Button>
            </>
          )}
        </div>
        <div
          data-scroll-shadow
          className="px-2 pt-2 pb-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto"
        >
          <KnowledgeTree
            collections={collections}
            nodes={nodes}
            canManage={canManage}
          />
        </div>
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
