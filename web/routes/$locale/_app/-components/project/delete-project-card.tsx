import { Trash2 } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { useDialog } from "@/components/dialog-provider";
import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";
import type { Project } from "@/lib/db/schema";
import { canOrg } from "@/lib/permissions";
import { removeProject } from "@/web/api/project-catalog";
import { useMe } from "@/web/api/session";

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
  // Only admins with integration:manage may delete escrowed variables too.
  const canDeleteEscrowed = canOrg(useMe()?.orgRole, {
    integration: ["manage"],
  });

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
      let result = await removeProject(project.id);
      if (!result.success && result.escrowed && canDeleteEscrowed) {
        const confirmed = await dialog.confirm({
          title: t("deleteEscrowedTitle"),
          description: t("deleteEscrowedDescription"),
          confirmText: tCommon("delete"),
          cancelText: tCommon("cancel"),
          destructive: true,
        });
        if (!confirmed) return;
        result = await removeProject(project.id, true);
      }
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
