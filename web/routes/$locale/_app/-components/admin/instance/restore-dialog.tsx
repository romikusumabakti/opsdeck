import { useQueryClient } from "@tanstack/react-query";
import { Loader2, RotateCcw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { refreshInstance, reportError } from "./report-error";

/**
 * Restore with a typed confirmation: the button stays disabled until the
 * instance name is typed. Used by the Backups history and the safety backup.
 */
export function RestoreDialog({
  instance,
  version,
  disabled,
  triggerLabel,
  onConfirm,
}: {
  instance: string;
  version: string;
  disabled?: boolean;
  triggerLabel: string;
  onConfirm: (confirm: string) => Promise<unknown>;
}) {
  const t = useTranslations("instanceUpdates.restoreDialog");
  const tCommon = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [sending, setSending] = useState(false);
  const queryClient = useQueryClient();

  async function confirm() {
    setSending(true);
    try {
      await onConfirm(typed);
      toast.success(t("requested"));
      setOpen(false);
      // The Updates tab shows the pending request and the run from here.
      await refreshInstance(queryClient);
    } catch (error) {
      reportError(error);
    } finally {
      setSending(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setTyped("");
      }}
    >
      <AlertDialogTrigger
        render={
          <Button type="button" variant="outline" size="sm" disabled={disabled}>
            <RotateCcw data-icon="inline-start" />
            {triggerLabel}
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("body", { version })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed === instance) void confirm();
          }}
        >
          <label htmlFor="restore-confirm" className="text-sm font-medium">
            {t("confirmLabel", { name: instance })}
          </label>
          <Input
            id="restore-confirm"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <AlertDialogFooter className="mt-2">
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <Button
              type="submit"
              variant="destructive"
              disabled={sending || typed !== instance}
            >
              {sending && (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              )}
              {t("confirm")}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
