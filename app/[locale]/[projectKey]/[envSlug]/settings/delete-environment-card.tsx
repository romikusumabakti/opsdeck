"use client";

import { Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";
import { deleteEnvironment } from "@/actions/environments";
import { useDialog } from "@/components/dialog-provider";
import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";
import type { Environment } from "@/lib/db/schema";

export function DeleteEnvironmentCard({
  environment,
}: {
  environment: Pick<Environment, "id" | "name">;
}) {
  const t = useTranslations("environmentSettings");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  async function onDelete() {
    const ok = await dialog.confirmTyping({
      title: t("deleteTitle"),
      description: t("deleteDescription", { name: environment.name }),
      phrase: environment.name,
      phraseLabel: tCommon("confirmTypingLabel"),
      placeholder: tCommon("confirmTypingPlaceholder"),
      confirmText: tCommon("delete"),
      cancelText: tCommon("cancel"),
    });
    if (!ok) return;

    startTransition(async () => {
      const result = await deleteEnvironment(environment.id);
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      toast.success(t("deletedSuccess", { name: environment.name }));
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
