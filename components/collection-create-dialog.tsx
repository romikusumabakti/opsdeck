"use client";

import { FolderPlus, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { createCollection } from "@/actions/knowledge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function CollectionCreateDialog() {
  const t = useTranslations("knowledge");
  const tCommon = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPending, startTransition] = useTransition();

  function onSubmit() {
    if (!name.trim()) return;
    startTransition(async () => {
      const res = await createCollection({
        name,
        description: description || null,
      });
      if (!res.success) {
        toast.error(res.message ?? tCommon("errorGeneric"));
        return;
      }
      toast.success(t("collectionCreated"));
      setName("");
      setDescription("");
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label={t("newCollection")}>
          <FolderPlus className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("newCollection")}</DialogTitle>
          <DialogDescription>{t("newCollectionHint")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="collection-name">{t("collectionName")}</Label>
            <Input
              id="collection-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="collection-desc">
              {t("collectionDescription")}
            </Label>
            <Input
              id="collection-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={isPending}
          >
            {tCommon("cancel")}
          </Button>
          <Button onClick={onSubmit} disabled={!name.trim() || isPending}>
            {isPending && <Loader2 className="size-4 animate-spin" />}
            {tCommon("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
