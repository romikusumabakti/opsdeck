import { BookOpen, Plus } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CollectionCreateDialog } from "@/components/collection-create-dialog";
import { KnowledgeTree } from "@/components/knowledge-tree";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { getServerSession, isAdmin, requireSession } from "@/lib/auth-session";
import { loadCollections, loadTreeNodes } from "@/lib/knowledge";

export default async function KnowledgeLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireSession();
  const session = await getServerSession();
  const admin = session ? isAdmin(session) : false;

  const [collections, nodes, t] = await Promise.all([
    loadCollections(),
    loadTreeNodes(),
    getTranslations("knowledge"),
  ]);

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      <aside className="lg:w-64 lg:shrink-0">
        <div className="lg:sticky lg:top-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2 px-2">
            <Link
              href="/knowledge"
              className="flex items-center gap-1.5 text-sm font-semibold"
            >
              <BookOpen className="size-4" />
              {t("title")}
            </Link>
            {admin && <CollectionCreateDialog />}
          </div>
          {collections.length > 0 && (
            <Button asChild size="sm" variant="outline" className="mx-2">
              <Link href="/knowledge/new">
                <Plus className="size-4" />
                {t("newDocument")}
              </Link>
            </Button>
          )}
          <div className="px-1">
            <KnowledgeTree collections={collections} nodes={nodes} />
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
