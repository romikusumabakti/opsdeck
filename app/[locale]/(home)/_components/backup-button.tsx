"use client";

import { DatabaseBackup } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";
import { createDatabaseBackup } from "@/actions/backups";
import { Button } from "@/components/ui/button";

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
