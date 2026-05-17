"use client";

import { Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";
import { deleteProject } from "@/actions/projects";
import { useDialog } from "@/components/dialog-provider";
import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";
import type { Project } from "@/lib/db/schema";

export function DeleteProjectCard({ project }: { project: Project }) {
  const t = useTranslations("projectSettings");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  async function onDelete() {
    const ok = await dialog.confirmTyping({
      title: t("deleteTitle"),
      description: t("deleteDescription", { name: project.name }),
      phrase: project.name,
      phraseLabel: tCommon("confirmTypingLabel"),
      placeholder: tCommon("confirmTypingPlaceholder"),
      confirmText: tCommon("delete"),
      cancelText: tCommon("cancel"),
    });
    if (!ok) return;

    startTransition(async () => {
      const result = await deleteProject(project.id);
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      toast.success(t("deletedSuccess", { name: project.name }));
      router.push("/");
      router.refresh();
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
