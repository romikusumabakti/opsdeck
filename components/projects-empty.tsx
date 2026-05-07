import { FolderPlus } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Link } from "@/i18n/navigation";

export async function ProjectsEmpty() {
  const t = await getTranslations("projectsEmpty");

  return (
    <div className="flex-1 flex items-center justify-center p-4">
      <EmptyState
        icon={FolderPlus}
        title={t("title")}
        description={t("description")}
        action={
          <Button asChild>
            <Link href="/projects/new">{t("create")}</Link>
          </Button>
        }
      />
    </div>
  );
}
