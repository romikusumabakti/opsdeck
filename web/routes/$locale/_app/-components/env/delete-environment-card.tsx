import { Trash2 } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { useDialog } from "@/components/dialog-provider";
import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";
import type { Environment } from "@/lib/db/schema";
import { canOrg } from "@/lib/permissions";
import { deleteEnvironment } from "@/web/api/environments";
import { useMe } from "@/web/api/session";

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
  // Only admins with integration:manage may delete escrowed variables too.
  const canDeleteEscrowed = canOrg(useMe()?.orgRole, {
    integration: ["manage"],
  });

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
      let result = await deleteEnvironment(environment.id);
      if (!result.success && result.escrowed && canDeleteEscrowed) {
        const confirmed = await dialog.confirm({
          title: t("deleteEscrowedTitle"),
          description: t("deleteEscrowedDescription"),
          confirmText: tCommon("delete"),
          cancelText: tCommon("cancel"),
          destructive: true,
        });
        if (!confirmed) return;
        result = await deleteEnvironment(environment.id, true);
      }
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      toast.success(t("deletedSuccess", { name: environment.name }));
      router.push("/");
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
