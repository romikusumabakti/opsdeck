"use client";

import { Bookmark, ChevronDown, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { createSavedView, deleteSavedView } from "@/actions/saved-views";
import { useDialog } from "@/components/dialog-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";

export type SavedViewItem = {
  id: string;
  name: string;
  params: Record<string, string>;
};

/**
 * Saved filter sets for the issue list. A view is just the page's query string,
 * so applying one is a navigation and saving one is a snapshot of the current
 * URL — nothing about the list has to be re-derived.
 *
 * Deleting lives in the dialog rather than inside the menu rows: a button
 * nested in a `menuitem` is unreachable by keyboard and announces as a single
 * conflicting control.
 */
export function IssuesSavedViews({
  views,
  currentParams,
  onApply,
}: {
  views: SavedViewItem[];
  /** The params a "save" should capture — the page's current query. */
  currentParams: Record<string, string>;
  onApply: (params: Record<string, string>) => void;
}) {
  const t = useTranslations("issues");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const router = useRouter();

  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  async function onSave() {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    const result = await createSavedView(trimmed, currentParams);
    setSaving(false);
    if (!result.success) {
      toast.error(t("viewSaveFailed"));
      return;
    }
    toast.success(t("viewSaved"));
    setName("");
    setOpen(false);
    router.refresh();
  }

  async function onDelete(view: SavedViewItem) {
    const ok = await dialog.confirm({
      title: t("deleteViewTitle"),
      description: t("deleteViewDescription", { name: view.name }),
      confirmText: tCommon("delete"),
      cancelText: tCommon("cancel"),
      destructive: true,
    });
    if (!ok) return;
    const result = await deleteSavedView(view.id);
    if (!result.success) {
      toast.error(t("viewDeleteFailed"));
      return;
    }
    toast.success(t("viewDeleted"));
    router.refresh();
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" size="sm" className="gap-1.5">
              <Bookmark className="size-4" />
              {t("views")}
              <ChevronDown className="size-3.5 opacity-60" />
            </Button>
          }
        />
        <DropdownMenuContent align="start" className="w-56">
          {views.length === 0 ? (
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              {t("noSavedViews")}
            </DropdownMenuLabel>
          ) : (
            views.map((v) => (
              <DropdownMenuItem key={v.id} onClick={() => onApply(v.params)}>
                <span className="truncate">{v.name}</span>
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setOpen(true)}>
            <Bookmark className="size-4" />
            {t("manageViews")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("manageViews")}</DialogTitle>
            <DialogDescription>{t("saveViewDescription")}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("viewNamePlaceholder")}
              aria-label={t("viewName")}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSave();
              }}
            />
          </div>

          {views.length > 0 && (
            <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto">
              {views.map((v) => (
                <li
                  key={v.id}
                  className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60"
                >
                  <span className="truncate text-sm">{v.name}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("deleteView")}
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => onDelete(v)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
            <Button onClick={onSave} disabled={!name.trim() || saving}>
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
