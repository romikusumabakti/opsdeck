import { FolderPlus } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { ProjectCreateDialog } from "@/components/project-create-dialog";
import { Button } from "@/components/ui/button";

// The "New project" CTA on the projects landing — creates a logical project
// (the parent), distinct from "New environment" which registers a deployment.
export function NewProjectButton() {
  const t = useTranslations("home");
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <FolderPlus className="size-4" />
        {t("newProject")}
      </Button>
      <ProjectCreateDialog
        open={open}
        onOpenChange={setOpen}
        onCreated={() => {
          setOpen(false);
        }}
      />
    </>
  );
}
