import { Loader2 } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateCollection } from "@/web/api/knowledge";

// Mount it per rename (`key` by collection id) so the field starts from the
// current name; `onClose` fires after a save or a dismiss.
export function CollectionRenameDialog({
  collection,
  onClose,
}: {
  collection: { id: string; name: string };
  onClose: () => void;
}) {
  const t = useTranslations("knowledge");
  const tCommon = useTranslations("common");
  const [name, setName] = useState(collection.name);
  const [isPending, startTransition] = useTransition();
  const canSave = name.trim().length > 0 && name !== collection.name;

  function onSubmit() {
    if (!canSave) return;
    startTransition(async () => {
      const res = await updateCollection(collection.id, { name });
      if (!res.success) {
        toast.error(res.message ?? tCommon("errorGeneric"));
        return;
      }
      toast.success(t("collectionRenamed"));
      onClose();
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>{t("renameCollection")}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="collection-rename-name">
              {t("collectionName")}
            </Label>
            <Input
              id="collection-rename-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={isPending}
            >
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={!canSave || isPending}>
              {isPending && <Loader2 className="size-4 animate-spin" />}
              {tCommon("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
