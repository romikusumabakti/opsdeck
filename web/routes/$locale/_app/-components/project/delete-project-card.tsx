import { Trash2 } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { useDialog } from "@/components/dialog-provider";
import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";
import type { Project } from "@/lib/db/schema";
import { removeProject } from "@/web/api/project-catalog";

export function DeleteProjectCard({
  project,
  environmentCount,
}: {
  project: Pick<Project, "id" | "name">;
  environmentCount: number;
}) {
  const t = useTranslations("projectSettings");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  async function onDelete() {
    // Type-the-name confirmation, as with environments — deleting a project
    // cascades to every environment, run, and issue underneath it.
    const ok = await dialog.confirmTyping({
      title: t("deleteTitle"),
      description: t("deleteDescription", {
        name: project.name,
        count: environmentCount,
      }),
      phrase: project.name,
      phraseLabel: tCommon("confirmTypingLabel"),
      placeholder: tCommon("confirmTypingPlaceholder"),
      confirmText: tCommon("delete"),
      cancelText: tCommon("cancel"),
    });
    if (!ok) return;

    startTransition(async () => {
      const result = await removeProject(project.id);
      if (!result.success) {
        toast.error(result.message ?? tCommon("errorGeneric"));
        return;
      }
      toast.success(t("deletedSuccess", { name: project.name }));
      router.push("/projects");
    });
  }

  return (
    <Button
      type="button"
      variant="destructive"
      onClick={onDelete}
      disabled={isPending}
    >
      <Trash2 className="size-4" />
      {t("deleteButton")}
    </Button>
  );
}
