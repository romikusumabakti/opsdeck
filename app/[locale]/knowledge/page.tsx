import { BookOpen, Plus } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Link } from "@/i18n/navigation";
import { requireSession } from "@/lib/auth-session";
import { loadCollections } from "@/lib/knowledge";

export default async function KnowledgeHome({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireSession();

  const [collections, t] = await Promise.all([
    loadCollections(),
    getTranslations("knowledge"),
  ]);

  if (collections.length === 0) {
    return (
      <EmptyState
        className="h-full justify-center"
        icon={BookOpen}
        title={t("emptyTitle")}
        description={t("emptyAdminHint")}
      />
    );
  }

  return (
    <EmptyState
      className="h-full justify-center"
      icon={BookOpen}
      title={t("landingTitle")}
      description={t("landingHint")}
      action={
        <Button asChild>
          <Link href="/knowledge/new">
            <Plus className="size-4" />
            {t("newDocument")}
          </Link>
        </Button>
      }
    />
  );
}
