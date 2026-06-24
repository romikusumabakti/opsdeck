"use client";

import { Loader2, RotateCcw } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { restoreRevision } from "@/actions/knowledge";
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
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useRouter } from "@/i18n/navigation";

type Revision = {
  id: string;
  title: string;
  content: string;
  createdAt: Date;
  editedBy: { id: string; name: string } | null;
};

export function KnowledgeHistoryClient({
  documentId,
  documentSlug,
  revisions,
}: {
  documentId: string;
  documentSlug: string;
  revisions: Revision[];
}) {
  const t = useTranslations("knowledge");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [restoringId, setRestoringId] = useState<string | null>(null);

  function onRestore(revisionId: string) {
    setRestoringId(revisionId);
    startTransition(async () => {
      const res = await restoreRevision(documentId, revisionId);
      setRestoringId(null);
      if (!res.success || !res.data) {
        toast.error(res.message ?? tCommon("errorGeneric"));
        return;
      }
      toast.success(t("restored"));
      router.push(`/knowledge/${res.data.slug}`);
    });
  }

  if (revisions.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("noRevisions")}</p>;
  }

  return (
    <ul className="flex flex-col gap-3">
      {revisions.map((rev) => (
        <li key={rev.id}>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="truncate text-sm font-medium">
                  {rev.title}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("editedBy", {
                    name: rev.editedBy?.name ?? tCommon("you"),
                    time: format.dateTime(new Date(rev.createdAt), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }),
                  })}
                </span>
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" disabled={isPending}>
                    {isPending && restoringId === rev.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <RotateCcw className="size-4" />
                    )}
                    {t("restore")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("restoreConfirmTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("restoreConfirmBody")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => onRestore(rev.id)}>
                      {t("restore")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </CardHeader>
            {rev.content.trim() && (
              <CardContent>
                <p className="line-clamp-3 text-xs text-muted-foreground whitespace-pre-wrap">
                  {rev.content}
                </p>
              </CardContent>
            )}
          </Card>
        </li>
      ))}
    </ul>
  );
}
