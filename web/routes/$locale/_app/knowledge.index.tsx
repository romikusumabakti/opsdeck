import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BookOpen, Plus } from "lucide-react";
import { useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Link } from "@/i18n/navigation";
import { listCollectionsQuery } from "@/web/api/knowledge";
import { loaderQuery } from "@/web/query-client";

export const Route = createFileRoute("/$locale/_app/knowledge/")({
  loader: async ({ context: { queryClient } }) => {
    await loaderQuery(queryClient, listCollectionsQuery());
  },
  component: KnowledgeHome,
});

function KnowledgeHome() {
  const t = useTranslations("knowledge");
  const collections = useSuspenseQuery(listCollectionsQuery()).data;

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
        <Button nativeButton={false} render={<Link href="/knowledge/new" />}>
          <Plus className="size-4" />
          {t("newDocument")}
        </Button>
      }
    />
  );
}
