"use client";

import { Loader2, MoreHorizontal, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { toast } from "sonner";
import {
  createDocument,
  deleteDocument,
  updateDocument,
} from "@/actions/knowledge";
import {
  KnowledgeEditor,
  type LinkableDoc,
} from "@/components/knowledge-editor";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useRouter } from "@/i18n/navigation";
import type { KnowledgeCollection, KnowledgeDocument } from "@/lib/db/schema";

type Mode =
  | { type: "create"; defaultCollectionId?: string }
  | { type: "edit"; document: KnowledgeDocument; canDelete: boolean };

export function DocumentForm({
  mode,
  collections,
  linkableDocs = [],
  toolbarStart,
}: {
  mode: Mode;
  collections: KnowledgeCollection[];
  linkableDocs?: LinkableDoc[];
  toolbarStart?: ReactNode;
}) {
  const t = useTranslations("knowledge");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const doc = mode.type === "edit" ? mode.document : null;
  const [title, setTitle] = useState(doc?.title ?? "");
  const [content, setContent] = useState(doc?.content ?? "");
  const [collectionId, setCollectionId] = useState(
    doc?.collectionId ??
      (mode.type === "create" ? mode.defaultCollectionId : undefined) ??
      collections[0]?.id ??
      ""
  );
  const [published, setPublished] = useState(
    doc ? doc.publishedAt !== null : true
  );
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Snapshot of the form as first rendered; edits are diffed against it to drive
  // the unsaved-changes guard below.
  const initialRef = useRef({
    title: doc?.title ?? "",
    content: doc?.content ?? "",
    collectionId,
    published,
  });
  const initial = initialRef.current;
  const dirty =
    title !== initial.title ||
    content !== initial.content ||
    collectionId !== initial.collectionId ||
    published !== initial.published;

  // Warn before a full-page unload (refresh, tab close, external nav) drops
  // unsaved edits. Browsers ignore any custom message, so none is set. Client
  // router navigations don't trigger this and intentionally aren't blocked.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const canSubmit = title.trim().length > 0 && collectionId && !isPending;

  function onSubmit() {
    if (!canSubmit) return;
    startTransition(async () => {
      if (mode.type === "create") {
        const res = await createDocument({ collectionId, title, content });
        if (!res.success || !res.data) {
          toast.error(res.message ?? tCommon("errorGeneric"));
          return;
        }
        // Publish state on create: if left unpublished, flip it after insert.
        if (!published) {
          await updateDocument(res.data.id, { publishedAt: null });
        }
        toast.success(t("created"));
        router.push(`/knowledge/${res.data.slug}`);
      } else {
        const res = await updateDocument(mode.document.id, {
          title,
          content,
          collectionId,
          publishedAt: published ? new Date().toISOString() : null,
        });
        if (!res.success || !res.data) {
          toast.error(res.message ?? tCommon("errorGeneric"));
          return;
        }
        toast.success(t("saved"));
        router.push(`/knowledge/${res.data.slug}`);
      }
    });
  }

  function onDelete() {
    if (mode.type !== "edit") return;
    startTransition(async () => {
      const res = await deleteDocument(mode.document.id);
      if (!res.success) {
        toast.error(res.message ?? tCommon("errorGeneric"));
        return;
      }
      toast.success(t("deleted"));
      router.push("/knowledge");
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-4 bg-background px-4 pt-4 pb-3 sm:px-6 lg:px-8">
        <div className="min-w-0 flex-1">{toolbarStart}</div>
        <div className="flex shrink-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <label
                htmlFor="doc-published"
                className="flex cursor-pointer items-center gap-2 pe-1 text-sm"
              >
                <Switch
                  id="doc-published"
                  checked={published}
                  onCheckedChange={setPublished}
                />
                {t("published")}
              </label>
            </TooltipTrigger>
            <TooltipContent>{t("publishedHint")}</TooltipContent>
          </Tooltip>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.back()}
            disabled={isPending}
          >
            {tCommon("cancel")}
          </Button>
          <Button size="sm" onClick={onSubmit} disabled={!canSubmit}>
            {isPending && <Loader2 className="size-4 animate-spin" />}
            {tCommon("save")}
          </Button>

          {mode.type === "edit" && mode.canDelete && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={tCommon("more")}
                  disabled={isPending}
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => setConfirmOpen(true)}
                >
                  <Trash2 className="size-4" />
                  {tCommon("delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {mode.type === "edit" && mode.canDelete && (
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("deleteConfirmTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("deleteConfirmBody")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isPending}>
                {tCommon("cancel")}
              </AlertDialogCancel>
              <AlertDialogAction onClick={onDelete} disabled={isPending}>
                {tCommon("delete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      <div
        data-scroll-shadow
        className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-6 lg:px-8"
      >
        <div className="mx-auto flex w-full max-w-[46rem] flex-col gap-4 pt-6 pb-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1 flex flex-col gap-1.5">
              <Label htmlFor="doc-title">{t("titleLabel")}</Label>
              <Input
                id="doc-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("titlePlaceholder")}
                className="text-base font-medium"
              />
            </div>
            <div className="flex shrink-0 flex-col gap-1.5">
              <Label htmlFor="doc-collection">{t("collection")}</Label>
              <Select value={collectionId} onValueChange={setCollectionId}>
                <SelectTrigger id="doc-collection">
                  <SelectValue placeholder={t("collection")} />
                </SelectTrigger>
                <SelectContent>
                  {collections.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>{t("content")}</Label>
            <KnowledgeEditor
              value={content}
              onChange={setContent}
              placeholder={t("contentPlaceholder")}
              linkableDocs={linkableDocs}
              linkLabels={{
                title: t("linkDocument"),
                search: t("searchPlaceholder"),
                empty: t("searchNoResults"),
              }}
              linkInputLabels={{
                label: t("linkUrl"),
                placeholder: t("linkUrlPlaceholder"),
                apply: t("linkApply"),
                remove: t("linkRemove"),
              }}
              uploadLabels={{
                button: t("insertImage"),
                tooLarge: t("imageTooLarge"),
                failed: t("imageUploadFailed"),
              }}
              tableLabels={{
                addRow: t("tableAddRow"),
                deleteRow: t("tableDeleteRow"),
                addColumn: t("tableAddColumn"),
                deleteColumn: t("tableDeleteColumn"),
                deleteTable: t("tableDelete"),
              }}
              imageAltLabels={{
                edit: t("imageAltEdit"),
                placeholder: t("imageAltPlaceholder"),
                apply: t("linkApply"),
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
