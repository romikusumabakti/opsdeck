import { DatabaseBackup } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import { createDatabaseBackup } from "@/web/api/backups";

// The new run shows up in the Running rail through the shared SSE stream.
export function BackupButton({ environmentId }: { environmentId: string }) {
  const t = useTranslations("homePage");
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="ghost"
      size="xs"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          try {
            await createDatabaseBackup(environmentId);
            toast.success(t("recent.backupStarted"));
          } catch {
            toast.error(t("recent.backupFailed"));
          }
        })
      }
    >
      <DatabaseBackup />
      {t("recent.backup")}
    </Button>
  );
}
