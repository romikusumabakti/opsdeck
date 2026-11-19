import { Eye } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { useProjectCan } from "@/components/project-role";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { setEnvFileManaged } from "@/web/api/variables";
import {
  EnvFilePreviewDialog,
  type EnvFilePreviewMode,
  useManagedSwitchErrorText,
} from "../variables/env-file-preview-dialog";
import { Hint } from "./fields";
import type { SettingsEnvironment } from "./settings-form";

/**
 * Whether deploys render the environment's `.env` (moved here from the
 * Variables page). Saves on its own. Turning it on opens the preview of the
 * `.env` the next deploy would write, which enables at once when nothing
 * changes and asks for a confirm otherwise; it stays off whenever the
 * preview cannot load. Turning it off is immediate. "Preview .env" opens the
 * same preview read-only.
 */
export function EnvFileManagedSwitch({
  environment,
}: {
  environment: Pick<SettingsEnvironment, "id" | "envFileManaged">;
}) {
  const t = useTranslations("variables");
  const errorText = useManagedSwitchErrorText();
  const canSwitch = useProjectCan({
    variable: ["write"],
    deploy: ["configure"],
  });
  const canPreview = useProjectCan({
    variable: ["read"],
    deploy: ["configure"],
  });
  const [busy, setBusy] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  // Kept while the dialog closes, so its title does not flip.
  const [mode, setMode] = useState<EnvFilePreviewMode>("view");

  function openPreview(next: EnvFilePreviewMode) {
    setMode(next);
    setPreviewOpen(true);
  }

  async function turnOff() {
    setBusy(true);
    try {
      await setEnvFileManaged(environment.id, false);
      toast.success(t("managedOff"));
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Switch
          id="env-file-managed"
          checked={environment.envFileManaged}
          disabled={!canSwitch || busy}
          onCheckedChange={(checked) => {
            if (checked) openPreview("enable");
            else void turnOff();
          }}
        />
        <Label htmlFor="env-file-managed">{t("managedTitle")}</Label>
        {canPreview && (
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() => openPreview("view")}
          >
            <Eye data-icon="inline-start" />
            {t("envPreview.link")}
          </Button>
        )}
      </div>
      <Hint>{t("managedDescription")}</Hint>
      <EnvFilePreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        environmentId={environment.id}
        mode={mode}
      />
    </section>
  );
}
