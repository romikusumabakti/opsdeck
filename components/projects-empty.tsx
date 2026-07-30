"use client";

import { FolderPlus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ProjectCreateDialog } from "@/components/project-create-dialog";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useRouter } from "@/i18n/navigation";

// Shown when no logical project exists yet. The first step is creating the
// project, not a deployment — environments are added from its card afterwards.
export function ProjectsEmpty({ canCreate }: { canCreate: boolean }) {
  const t = useTranslations("projectsEmpty");
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <div className="flex-1 flex items-center justify-center p-4">
      <EmptyState
        icon={FolderPlus}
        title={t("title")}
        description={t("description")}
        action={
          canCreate ? (
            <Button onClick={() => setOpen(true)}>{t("create")}</Button>
          ) : undefined
        }
      />
      <ProjectCreateDialog
        open={open}
        onOpenChange={setOpen}
        onCreated={() => {
          setOpen(false);
          router.refresh();
        }}
      />
    </div>
  );
}
