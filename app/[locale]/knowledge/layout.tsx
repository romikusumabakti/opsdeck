import { BookOpen, Plus } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CollectionCreateDialog } from "@/components/collection-create-dialog";
import { KnowledgeSearch } from "@/components/knowledge-search";
import { KnowledgeTree } from "@/components/knowledge-tree";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { requireOrgPage } from "@/lib/authz";
import { loadCollections, loadTreeNodes } from "@/lib/knowledge";
import { canOrg } from "@/lib/permissions";

export default async function KnowledgeLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await requireOrgPage({ knowledge: ["read"] });
  const canManage = canOrg(session.user.role, { knowledge: ["manage"] });

  const [collections, nodes, t] = await Promise.all([
    loadCollections(),
    loadTreeNodes(),
    getTranslations("knowledge"),
  ]);

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
        {children}
      </main>
    </div>
  );
}
