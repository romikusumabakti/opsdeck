"use client";

import { Loader2, Save, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRouter } from "@/i18n/navigation";
import type { KnowledgeCollection, KnowledgeDocument } from "@/lib/db/schema";

type Mode =
  | { type: "create"; defaultCollectionId?: string }
  | { type: "edit"; document: KnowledgeDocument; canDelete: boolean };

export function DocumentForm({
  mode,
  collections,
  linkableDocs = [],
}: {
  mode: Mode;
  collections: KnowledgeCollection[];
  linkableDocs?: LinkableDoc[];
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
    <div className="flex flex-col gap-4">
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
        <div className="flex flex-col gap-1.5 sm:w-56">
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
        />
      </div>

      <div className="flex items-center gap-2">
        <Checkbox
          id="doc-published"
          checked={published}
          onCheckedChange={(v) => setPublished(v === true)}
        />
        <Label htmlFor="doc-published" className="text-sm font-normal">
          {t("publishedHint")}
        </Label>
      </div>

      <div className="sticky bottom-0 z-10 flex items-center justify-between gap-2 border-t bg-background pt-4 pb-2">
        <div>
          {mode.type === "edit" && mode.canDelete && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" disabled={isPending}>
                  <Trash2 className="size-4" />
                  {tCommon("delete")}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("deleteConfirmTitle")}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("deleteConfirmBody")}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
                  <AlertDialogAction onClick={onDelete}>
                    {tCommon("delete")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            onClick={() => router.back()}
            disabled={isPending}
          >
            {tCommon("cancel")}
          </Button>
          <Button onClick={onSubmit} disabled={!canSubmit}>
            {isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            {tCommon("save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
