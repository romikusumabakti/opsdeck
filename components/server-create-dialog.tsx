import { useTranslations } from "use-intl";
import { ServerForm } from "@/components/server-form";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { SafeServer } from "@/lib/db/schema";
import type { Serialized } from "@/web/api/client";

export function ServerCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (server: Serialized<SafeServer>) => void;
}) {
  const t = useTranslations("newServer");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <ServerForm
          mode={{ type: "create" }}
          onSuccess={(server) => {
            onCreated(server);
            onOpenChange(false);
          }}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
